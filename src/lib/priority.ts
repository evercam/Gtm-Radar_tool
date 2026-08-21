/**
 * Lead priority engine. Answers "which record should an SDR touch first?" —
 * a different question from completeness (how much data do we have) and from
 * key-account (is this company worth an ABM motion).
 *
 * Every parameter is admin-configurable: the weights, band cut-offs,
 * saturation points, ICP/vertical lists and the phase-timing table all live in
 * the `scoring_policy` row edited on /settings. The constants below are only
 * the fallback used before anything is saved.
 *
 * The scoring function itself is pure and deterministic, like lib/routing and
 * lib/keyaccount: config in, verdict out, no I/O and no clock except the
 * injectable `now`. The same call powers the stateless /api/search preview,
 * the materialized re-score pass, the routing rules, and the enrichment queue.
 */

export type PriorityBand = 'P1' | 'P2' | 'P3' | 'P4';

export interface PriorityInputs {
  icp_code?: string | null;
  record_type?: string | null;
  vertical?: string | null;
  current_phase?: string | null;
  estimated_value?: number | null;
  estimated_value_currency?: string | null;
  capacity_mw?: number | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  /** Precomputed status — when absent it's derived from the contact fields. */
  contact_status?: string | null;
  population_percentage?: number | null;
  bid_date?: string | null;
  construction_start_date?: string | null;
  announced_date?: string | null;
  created_at?: string | null;
  /** Account-level signals, joined from account_enrichment when available. */
  key_account?: boolean | null;
  key_account_score?: number | null;
}

export interface PriorityVerdict {
  score: number;
  band: PriorityBand;
  reasons: string[];
}

/** One row of the admin-editable phase table: substring → timing weight. */
export interface PhaseRule {
  /** Lowercased substring matched against `current_phase`. */
  match: string;
  /** 0..1 — how close this phase is to the moment Evercam gets installed. */
  weight: number;
  /** Human label shown in the record's priority reasons. */
  label: string;
  /**
   * Has construction actually begun at this phase?
   *
   * Separate from `weight`, which measures how close we are to the moment
   * Evercam is installed — "pre-construction" scores 1 because it is the ideal
   * moment to sell, not because anyone is on site. Arrival needs the other
   * question: a completion date means "months of build remaining" only once
   * building has started, and before that it is a target.
   *
   * Absent means not started, which is the safe default: it stops a date from
   * asserting that work is underway when nothing says it is.
   */
  started?: boolean;
}

export interface PriorityWeights {
  timing: number;
  scale: number;
  icpFit: number;
  contact: number;
  keyAccount: number;
  freshness: number;
}

export interface PriorityConfig {
  /** Lower bound of each band (checked high to low); P4 is everything below P3. */
  bands: { P1: number; P2: number; P3: number };
  /** Component weights — these should total 100, but any total is normalized. */
  weights: PriorityWeights;
  /** Money value (record currency) at which the scale component saturates. */
  valueSaturation: number;
  /** Capacity at which the scale component saturates, for energy assets. */
  capacitySaturation_MW: number;
  /** Days over which the freshness component decays to zero. */
  freshnessWindowDays: number;
  /** ICP codes that earn the full ICP-fit weight. */
  strategicIcps: string[];
  /** ICP codes that earn half of it. */
  secondaryIcps: string[];
  /** Verticals that top up the ICP-fit component. */
  coreVerticals: string[];
  /** Phase table, evaluated in order — first substring match wins. */
  phaseTiming: PhaseRule[];
  /** Timing fallback per record_type when a record carries no phase. */
  recordTypeTiming: Record<string, number>;
  /** Score ceiling applied to records whose phase scored 0 (complete/cancelled). */
  deadPhaseCap: number;
}

/**
 * Default phase timing. Evercam is bought when a site is about to break ground
 * or has just started — earliest planning is too speculative to call, and a
 * finished or cancelled project is dead. The vocabularies of every source are
 * folded into one table (Glenigan phases, ConstructConnect statuses, GEM
 * statuses, OCDS tender stages), most specific first.
 */
export const DEFAULT_PHASE_TIMING: PhaseRule[] = [
  // dead — nothing to sell
  { match: 'complete', weight: 0, label: 'project complete' },
  { match: 'occupancy', weight: 0, label: 'project complete' },
  { match: 'cancelled', weight: 0, label: 'cancelled' },
  { match: 'canceled', weight: 0, label: 'cancelled' },
  { match: 'abandoned', weight: 0, label: 'abandoned' },
  { match: 'retired', weight: 0, label: 'retired' },
  { match: 'shelved', weight: 0.05, label: 'shelved' },
  { match: 'mothballed', weight: 0.05, label: 'mothballed' },
  // Measured against the live corpus: 679 records carried a phase this table did
  // not match, so they fell through to the record-type default of 0.4 — a MIDDLE
  // timing score. That is the wrong direction for the dead ones. "Closed" and
  // "Idled" were being weighted like live projects, and 0.4 of a 30-point
  // component is enough to lift a finished asset above a real pre-construction
  // project. Ordered above the live rules because 'closed' must not be reached
  // by anything else first.
  { match: 'closed', weight: 0, label: 'closed' },
  { match: 'idled', weight: 0.05, label: 'idled' },
  { match: 'idle', weight: 0.05, label: 'idle' },
  { match: 'on hold', weight: 0.05, label: 'on hold' },
  // prime window — breaking ground now
  { match: 'pre-construction', weight: 1, label: 'pre-construction — prime window' },
  { match: 'preconstruction', weight: 1, label: 'pre-construction — prime window' },
  { match: 'construction start', weight: 1, label: 'construction starting' },
  { match: 'contract awarded', weight: 1, label: 'contract awarded' },
  { match: 'award', weight: 0.95, label: 'awarded' },
  { started: true, match: 'on site', weight: 0.95, label: 'on site' },
  { started: true, match: 'under construction', weight: 0.9, label: 'under construction' },
  { started: true, match: 'construction', weight: 0.9, label: 'in construction' },
  { match: 'operating', weight: 0.1, label: 'already operating' },
  // approaching — work it now to be there at award
  { match: 'bid results', weight: 0.85, label: 'bid results in' },
  { match: 'post-bid', weight: 0.85, label: 'post-bid' },
  { match: 'sub-bidding', weight: 0.8, label: 'sub-bidding' },
  { match: 'tender', weight: 0.8, label: 'at tender' },
  { match: 'bidding', weight: 0.8, label: 'bidding' },
  { match: 'solicitation', weight: 0.75, label: 'solicitation open' },
  { match: 'plans approved', weight: 0.7, label: 'plans approved' },
  { match: 'approved', weight: 0.7, label: 'approved' },
  { match: 'final planning', weight: 0.65, label: 'final planning' },
  // early — nurture
  { match: 'detailed plans', weight: 0.5, label: 'detailed plans submitted' },
  { match: 'permit', weight: 0.5, label: 'permitting' },
  { match: 'design', weight: 0.45, label: 'in design' },
  { match: 'planning', weight: 0.35, label: 'in planning' },
  { match: 'early planning', weight: 0.3, label: 'early planning' },
  { match: 'announced', weight: 0.3, label: 'announced only' },
  { match: 'conceptual', weight: 0.25, label: 'conceptual' },
  { match: 'pre-announcement', weight: 0.2, label: 'pre-announcement' },
  // The rest of the unmatched values, each placed by what it means for install
  // timing rather than by how early it sounds.
  //
  // `commissioning` is the one worth arguing about: the plant is being handed
  // over, so construction is essentially done and there is nothing left to put a
  // camera on. It reads late-stage-and-active, which is exactly why the 0.4
  // default flattered it.
  { started: true, match: 'commissioning', weight: 0.15, label: 'commissioning — build finishing' },
  { match: 'in process', weight: 0.8, label: 'in process' },
  { match: 'issued', weight: 0.7, label: 'permit issued' },
  { match: 'new application', weight: 0.45, label: 'application filed' },
  { match: 'pre_validation', weight: 0.4, label: 'awaiting validation' },
  { match: 'ai received', weight: 0.4, label: 'application received' },
  { match: 'officer allocation', weight: 0.4, label: 'with a case officer' },
  { match: 'valid', weight: 0.4, label: 'application valid' },
  { match: 'announcement', weight: 0.3, label: 'announced only' },
  { match: 'proposed', weight: 0.3, label: 'proposed' },
  { match: 'in-development', weight: 0.3, label: 'in development' },
  { match: 'active', weight: 0.3, label: 'active — stage unstated' },
  { match: 'pipeline', weight: 0.2, label: 'in the pipeline' },
  /*
    0.3, not 0.15. At 0.15 this sat exactly on `arrival.ts`'s DEAD_BELOW floor,
    which uses `<=` — so "newly discovered — stage unknown" was judged `too_late`,
    `too_late` is in COLD_ARRIVALS, and the earliest signal this tool can receive
    was excluded from enrichment and the Apollo export outright.

    The label says stage UNKNOWN. That is an absence, not a death, and it belongs
    with its semantic twin `active — stage unstated` on 0.3 rather than beside
    `commissioning`, which is on the floor deliberately because the build is over.

    Measured 2026-08-13: 25 records carry a discovered phase, so this rescues 25
    from a pool of 101,897. Small, and worth doing anyway — they are the earliest
    signals in the book, and the bug would have kept scaling with every new
    discovery source.
  */
  { match: 'discovered', weight: 0.3, label: 'newly discovered — stage unknown' },
];

export const DEFAULT_PRIORITY_CONFIG: PriorityConfig = {
  bands: { P1: 75, P2: 55, P3: 35 },
  weights: { timing: 30, scale: 25, icpFit: 15, contact: 12, keyAccount: 10, freshness: 8 },
  valueSaturation: 250_000_000,
  capacitySaturation_MW: 1_000,
  freshnessWindowDays: 365,
  strategicIcps: ['mission_critical_owner', 'critical_infra_owner', 'tier1_gc'],
  secondaryIcps: ['tier2_gc', 'developer'],
  /**
   * Verticals Evercam wins in — every sector that puts a structure on a site.
   *
   * The original list held eight energy and technology sectors and omitted the
   * rest of heavy construction, including a vertical literally called
   * `construction` (207 records, 150 of them live) and `pipeline` (918/148).
   * Also `mining`, `coal` and `steel`, which is how a rep scoped to mining ended
   * up with nothing: coal mines and steel plants are classified `coal` and
   * `steel`, so his scope never saw them and none of the three earned the
   * core-vertical top-up either.
   *
   * Deliberately NOT added: `procurement`, `capital_projects`, `market_intel` and
   * `other`. Those are record-type artefacts rather than construction sectors,
   * and a bonus every vertical receives discriminates nothing.
   *
   * Measured before committing: this moves 173 records from P4 to P3 and changes
   * P1/P2 by ZERO. It is a correctness fix, not a supply fix — these records fail
   * on timing and scale, and 3.75 points of vertical top-up cannot bridge that.
   * Recorded here so nobody expects it to have produced leads.
   */
  coreVerticals: [
    // energy and technology — the original list
    'data_center', 'semiconductor', 'battery', 'nuclear', 'solar', 'wind', 'hydro', 'oil_gas',
    // the rest of heavy construction, omitted until measured
    'construction', 'pipeline', 'mining', 'coal', 'steel', 'cement', 'power', 'chemicals',
    'bioenergy', 'pharma',
  ],
  phaseTiming: DEFAULT_PHASE_TIMING,
  recordTypeTiming: {
    tender: 0.75,
    permit: 0.6,
    project: 0.5,
    account: 0.5,
    contact: 0.5,
    filing: 0.35,
    signal: 0.3,
    news: 0.25,
  },
  deadPhaseCap: 15,
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Timing weight (0..1) for a phase string, plus the human label for it. */
export function phaseTiming(
  phase: string | null | undefined,
  recordType: string | null | undefined,
  config: PriorityConfig = DEFAULT_PRIORITY_CONFIG
): { weight: number; label: string | null; started: boolean } {
  const s = (phase ?? '').toLowerCase().trim();
  if (s) {
    for (const rule of config.phaseTiming) {
      if (rule.match && s.includes(rule.match.toLowerCase())) {
        return { weight: clamp01(rule.weight), label: rule.label, started: rule.started === true };
      }
    }
  }
  // An unrecognised phase says nothing about whether work has begun, so the
  // safe answer is "not started" — it stops a date claiming work is underway.
  return { weight: clamp01(config.recordTypeTiming[recordType ?? ''] ?? 0.4), label: null, started: false };
}

function daysSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (now - t) / 86_400_000;
}

/**
 * The most meaningful date for "how live is this": when the work actually
 * moves, else when it was announced, else when we ingested it.
 */
function anchorDate(i: PriorityInputs): string | null {
  return i.construction_start_date || i.bid_date || i.announced_date || i.created_at || null;
}

export function scorePriority(
  i: PriorityInputs,
  config: PriorityConfig = DEFAULT_PRIORITY_CONFIG,
  nowMs: number = Date.now()
): PriorityVerdict {
  const w = config.weights;
  // Weights are expressed out of 100 but an admin may not keep them there —
  // normalize so the score is always a percentage of what was achievable.
  const totalWeight = w.timing + w.scale + w.icpFit + w.contact + w.keyAccount + w.freshness || 1;
  const reasons: string[] = [];
  let score = 0;

  // 1. timing — normally the biggest driver
  const timing = phaseTiming(i.current_phase, i.record_type, config);
  score += w.timing * timing.weight;
  if (timing.label) reasons.push(timing.label);

  // 2. scale — money when we have it, capacity for energy assets that never
  //    carry a value. The stronger signal wins; they are not summed.
  const byValue = i.estimated_value ? clamp01(i.estimated_value / (config.valueSaturation || 1)) : 0;
  const byCapacity = i.capacity_mw ? clamp01(i.capacity_mw / (config.capacitySaturation_MW || 1)) : 0;
  score += w.scale * Math.max(byValue, byCapacity);
  if (i.estimated_value && i.estimated_value >= 10_000_000) {
    reasons.push(`${Math.round(i.estimated_value / 1_000_000)}M ${i.estimated_value_currency ?? ''}`.trim());
  } else if (i.capacity_mw && i.capacity_mw >= 50) {
    reasons.push(`${Math.round(i.capacity_mw).toLocaleString()} MW`);
  }

  // 3. ICP fit — strategic profiles take the full weight, secondary ones half,
  //    with a top-up for the verticals Evercam wins in.
  let icp = 0;
  if (i.icp_code && config.strategicIcps.includes(i.icp_code)) {
    icp = 1;
    reasons.push('strategic ICP');
  } else if (i.icp_code && config.secondaryIcps.includes(i.icp_code)) {
    icp = 0.5;
  }
  if (i.vertical && config.coreVerticals.includes(i.vertical)) {
    icp = clamp01(icp + 0.25);
    reasons.push(`core vertical (${i.vertical.replace(/_/g, ' ')})`);
  }
  score += w.icpFit * icp;

  // 4. contact readiness — a named human with an email is actionable today.
  const hasEmail = Boolean(i.contact_email);
  const hasPhone = Boolean(i.contact_phone);
  const hasName = Boolean(i.contact_name);
  const status = i.contact_status ?? (hasEmail || hasPhone || hasName ? 'has_contact' : 'needs_enrichment');
  const contact = hasEmail && hasName ? 1 : hasEmail || hasPhone ? 0.75 : hasName ? 0.4 : 0;
  score += w.contact * contact;
  if (contact >= 0.75) reasons.push('direct contact on file');
  else if (status === 'needs_enrichment') reasons.push('needs enrichment');

  // 5. key account — the account rollup, once enrichment has run.
  if (i.key_account) {
    score += w.keyAccount;
    reasons.push('key account');
  } else if (i.key_account_score) {
    score += w.keyAccount * clamp01(i.key_account_score / 100);
  }

  // 6. freshness — linear decay over the window from the record's anchor date.
  const age = daysSince(anchorDate(i), nowMs);
  if (age === null) {
    score += w.freshness * 0.5; // unknown age — neither reward nor punish
  } else {
    score += w.freshness * clamp01(1 - Math.max(0, age) / (config.freshnessWindowDays || 1));
    if (age <= 30 && age >= -365) reasons.push('fresh (last 30 days)');
    else if (age > config.freshnessWindowDays) reasons.push(`stale (${Math.round(age / 30)} months old)`);
  }

  let final = Math.round(clamp01(score / totalWeight) * 100);
  // However big it is, a complete or cancelled project is not a priority.
  if (timing.weight === 0) final = Math.min(final, config.deadPhaseCap);

  return { score: final, band: priorityBand(final, config), reasons };
}

export function priorityBand(score: number, config: PriorityConfig = DEFAULT_PRIORITY_CONFIG): PriorityBand {
  if (score >= config.bands.P1) return 'P1';
  if (score >= config.bands.P2) return 'P2';
  if (score >= config.bands.P3) return 'P3';
  return 'P4';
}

/**
 * Coerce an admin-saved (possibly partial or stale) config onto the defaults,
 * so a policy row written by an older version still scores. Unknown keys are
 * dropped; out-of-range numbers are clamped rather than rejected.
 */
export function mergePriorityConfig(input: unknown): PriorityConfig {
  const d = DEFAULT_PRIORITY_CONFIG;
  if (!input || typeof input !== 'object') return d;
  const p = input as Partial<PriorityConfig>;

  const num = (v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
  const strList = (v: unknown, fallback: string[]) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : fallback;

  const phase = Array.isArray(p.phaseTiming)
    ? p.phaseTiming
        .filter(
          (r): r is PhaseRule => Boolean(r) && typeof r === 'object' && typeof (r as PhaseRule).match === 'string'
        )
        .map((r) => ({
          match: r.match,
          weight: num(r.weight, 0.5, 0, 1),
          label: typeof r.label === 'string' ? r.label : r.match,
        }))
    : d.phaseTiming;

  const rtt: Record<string, number> = {};
  const rttInput = (p.recordTypeTiming ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries({ ...d.recordTypeTiming, ...rttInput })) rtt[k] = num(v, 0.4, 0, 1);

  return {
    bands: {
      P1: num(p.bands?.P1, d.bands.P1, 0, 100),
      P2: num(p.bands?.P2, d.bands.P2, 0, 100),
      P3: num(p.bands?.P3, d.bands.P3, 0, 100),
    },
    weights: {
      timing: num(p.weights?.timing, d.weights.timing, 0, 100),
      scale: num(p.weights?.scale, d.weights.scale, 0, 100),
      icpFit: num(p.weights?.icpFit, d.weights.icpFit, 0, 100),
      contact: num(p.weights?.contact, d.weights.contact, 0, 100),
      keyAccount: num(p.weights?.keyAccount, d.weights.keyAccount, 0, 100),
      freshness: num(p.weights?.freshness, d.weights.freshness, 0, 100),
    },
    valueSaturation: num(p.valueSaturation, d.valueSaturation, 1),
    capacitySaturation_MW: num(p.capacitySaturation_MW, d.capacitySaturation_MW, 1),
    freshnessWindowDays: num(p.freshnessWindowDays, d.freshnessWindowDays, 1),
    strategicIcps: strList(p.strategicIcps, d.strategicIcps),
    secondaryIcps: strList(p.secondaryIcps, d.secondaryIcps),
    coreVerticals: strList(p.coreVerticals, d.coreVerticals),
    phaseTiming: phase.length ? phase : d.phaseTiming,
    recordTypeTiming: rtt,
    deadPhaseCap: num(p.deadPhaseCap, d.deadPhaseCap, 0, 100),
  };
}

/** Validation for the admin editor — stricter than merge, with a reason. */
export function validatePriorityConfig(
  input: unknown
): { ok: true; config: PriorityConfig } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, error: 'Config must be an object.' };
  const p = input as Partial<PriorityConfig>;

  if (p.bands) {
    const { P1, P2, P3 } = { ...DEFAULT_PRIORITY_CONFIG.bands, ...p.bands };
    if (!(P1 > P2 && P2 > P3)) return { ok: false, error: 'Band thresholds must descend: P1 > P2 > P3.' };
  }
  if (p.weights) {
    for (const [k, v] of Object.entries(p.weights)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
        return { ok: false, error: `Weight "${k}" must be a number ≥ 0.` };
    }
    const total = Object.values(p.weights).reduce((a, b) => a + (b as number), 0);
    if (total <= 0) return { ok: false, error: 'At least one weight must be greater than zero.' };
  }
  if (p.phaseTiming !== undefined) {
    if (!Array.isArray(p.phaseTiming)) return { ok: false, error: 'phaseTiming must be an array.' };
    for (const [i, r] of p.phaseTiming.entries()) {
      const rule = r as PhaseRule;
      if (!rule || typeof rule.match !== 'string' || !rule.match.trim())
        return { ok: false, error: `Phase rule ${i + 1}: "match" is required.` };
      if (typeof rule.weight !== 'number' || rule.weight < 0 || rule.weight > 1)
        return { ok: false, error: `Phase rule "${rule.match}": weight must be between 0 and 1.` };
    }
  }
  for (const k of ['valueSaturation', 'capacitySaturation_MW', 'freshnessWindowDays'] as const) {
    if (p[k] !== undefined && (typeof p[k] !== 'number' || (p[k] as number) <= 0)) {
      return { ok: false, error: `${k} must be a positive number.` };
    }
  }
  return { ok: true, config: mergePriorityConfig(input) };
}

/** Band order for filter chips. Labels and colours live in lib/semantics. */
export const PRIORITY_BANDS: PriorityBand[] = ['P1', 'P2', 'P3', 'P4'];
