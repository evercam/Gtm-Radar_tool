/**
 * Enrichment prioritisation rules.
 *
 * The core principle of the platform: enrichment costs money per record, so
 * only records that will actually be contacted get enriched. These rules
 * decide which ones, in what order, and how many per day.
 *
 * Evaluated in `priority` order (1 first). Each rule takes records matching its
 * conditions until its daily limit is reached, then the next rule takes over
 * from what remains. A record already claimed by an earlier rule is never
 * re-counted — so overlapping rules degrade into "first rule wins", not into
 * double spend.
 *
 * Pure and deterministic, like lib/routing and lib/priority: rules and records
 * in, a selection out. No I/O — the job in api/prioritize does the reading and
 * writing around it.
 */

export interface RuleConditions {
  /** Business unit — geography in this product (usa | uk | ireland | apac | export). */
  bu?: string[];
  /** Sector: data_center, solar, nuclear… */
  vertical?: string[];
  /** Country or state, matched against the record's country. */
  region?: string[];
  icp?: string[];
  recordTypes?: string[];
  /** Minimum lead priority score (lib/priority), 0–100. */
  minPriorityScore?: number;
  /** Bands eligible, e.g. ["P1","P2"]. */
  bands?: string[];
  /** Only records ingested within this many days. */
  recencyDays?: number;
  /** Restrict to specific source keys. */
  sourceKeys?: string[];
  /** true = only records that already have an email; false = only those without. */
  hasEmail?: boolean;
  /** Minimum project value. */
  minValue?: number;
}

export interface RuleVolume {
  /** Records this rule may claim per day. */
  dailyLimit: number;
  /** Optional per-owner ceiling, applied when auto-assigning. */
  quotaPerUser?: number;
}

export interface RuleAction {
  enrich: boolean;
  autoAssign: boolean;
  generateDescription: boolean;
  /** Which channel this cohort is worked through — drives validation. */
  contactPriority: 'phone' | 'email' | 'both';
}

export interface EnrichmentRule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  conditions: RuleConditions;
  volume: RuleVolume;
  action: RuleAction;
}

/** The record shape the rules evaluate. */
export interface PrioritizableRecord {
  id: string;
  bu: string | null;
  vertical: string | null;
  country: string | null;
  icp_code: string | null;
  record_type: string | null;
  source_key: string | null;
  priority_score: number | null;
  priority_band: string | null;
  estimated_value: number | null;
  contact_email: string | null;
  created_at: string | null;
  status: string | null;
}

/**
 * Starter rules. Deliberately conservative — they claim the strongest records
 * first and cap the daily spend well below what the API limits allow.
 */
export const DEFAULT_ENRICHMENT_RULES: EnrichmentRule[] = [
  {
    id: 'hot_p1_no_contact',
    name: 'P1 without a contact — highest value first',
    priority: 1,
    enabled: true,
    conditions: { bands: ['P1'], hasEmail: false, recencyDays: 180 },
    volume: { dailyLimit: 100, quotaPerUser: 25 },
    action: { enrich: true, autoAssign: true, generateDescription: true, contactPriority: 'phone' },
  },
  {
    id: 'core_verticals_p2',
    name: 'P2 in a core vertical',
    priority: 2,
    enabled: true,
    conditions: {
      bands: ['P2'],
      vertical: ['data_center', 'semiconductor', 'battery', 'nuclear', 'solar', 'wind'],
      recencyDays: 180,
    },
    volume: { dailyLimit: 100, quotaPerUser: 25 },
    action: { enrich: true, autoAssign: true, generateDescription: true, contactPriority: 'email' },
  },
  {
    id: 'large_tenders',
    name: 'Large tenders and awards',
    priority: 3,
    enabled: true,
    conditions: { recordTypes: ['tender'], minValue: 10_000_000, minPriorityScore: 45 },
    volume: { dailyLimit: 50 },
    action: { enrich: true, autoAssign: false, generateDescription: true, contactPriority: 'email' },
  },
];

const inList = (value: string | null, list?: string[]): boolean => {
  if (!list || list.length === 0) return true;
  return value != null && list.includes(value);
};

/** Whether one record satisfies a rule's conditions. */
export function matchesRule(record: PrioritizableRecord, rule: EnrichmentRule, nowMs = Date.now()): boolean {
  const c = rule.conditions;

  if (!inList(record.bu, c.bu)) return false;
  if (!inList(record.vertical, c.vertical)) return false;
  if (!inList(record.country, c.region)) return false;
  if (!inList(record.icp_code, c.icp)) return false;
  if (!inList(record.record_type, c.recordTypes)) return false;
  if (!inList(record.source_key, c.sourceKeys)) return false;
  if (!inList(record.priority_band, c.bands)) return false;

  if (c.minPriorityScore !== undefined && (record.priority_score ?? 0) < c.minPriorityScore) return false;
  if (c.minValue !== undefined && (record.estimated_value ?? 0) < c.minValue) return false;
  if (c.hasEmail !== undefined && Boolean(record.contact_email) !== c.hasEmail) return false;

  if (c.recencyDays !== undefined && record.created_at) {
    const ageDays = (nowMs - new Date(record.created_at).getTime()) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays > c.recencyDays) return false;
  }

  return true;
}

export interface RuleSelection {
  ruleId: string;
  ruleName: string;
  recordIds: string[];
  action: RuleAction;
  /** Records that matched but fell outside the rule's daily limit. */
  overflow: number;
}

export interface SelectionResult {
  selections: RuleSelection[];
  /** Every record id selected, across all rules. */
  selectedIds: string[];
  /** Matched a rule but was cut by a daily limit or the global cap. */
  deferred: number;
  /** Matched no enabled rule at all. */
  unmatched: number;
}

/**
 * Runs the rules over a candidate set and returns what should be queued.
 *
 * `globalCap` is the policy's daily ceiling: the sum of the per-rule limits can
 * legitimately exceed it, and when it does the highest-priority rules are
 * satisfied first and the rest are deferred to tomorrow. That ordering is the
 * whole point — it means a budget shortfall costs you the weakest cohort, not
 * a random slice of every cohort.
 */
export function selectForEnrichment(
  records: PrioritizableRecord[],
  rules: EnrichmentRule[],
  globalCap: number,
  nowMs = Date.now()
): SelectionResult {
  const ordered = rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);

  const claimed = new Set<string>();
  const selections: RuleSelection[] = [];
  let deferred = 0;

  // Best records first within each rule, so a daily limit cuts the weakest.
  const candidates = [...records].sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));

  for (const rule of ordered) {
    const remainingGlobal = globalCap - claimed.size;
    if (remainingGlobal <= 0) {
      // Everything this rule would have taken is deferred, not lost.
      deferred += candidates.filter((r) => !claimed.has(r.id) && matchesRule(r, rule, nowMs)).length;
      continue;
    }

    const matched = candidates.filter((r) => !claimed.has(r.id) && matchesRule(r, rule, nowMs));
    const limit = Math.min(rule.volume.dailyLimit, remainingGlobal);
    const taken = matched.slice(0, limit);
    const overflow = matched.length - taken.length;

    for (const r of taken) claimed.add(r.id);
    deferred += overflow;

    if (taken.length > 0 || overflow > 0) {
      selections.push({
        ruleId: rule.id,
        ruleName: rule.name,
        recordIds: taken.map((r) => r.id),
        action: rule.action,
        overflow,
      });
    }
  }

  const matchedAny = new Set<string>();
  for (const rule of ordered) {
    for (const r of candidates) if (matchesRule(r, rule, nowMs)) matchedAny.add(r.id);
  }

  return {
    selections,
    selectedIds: Array.from(claimed),
    deferred,
    unmatched: candidates.filter((r) => !matchedAny.has(r.id)).length,
  };
}

/** Validation for the admin editor — stricter than merge, with a reason. */
export function validateRules(input: unknown): { ok: true; rules: EnrichmentRule[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'Rules must be an array.' };

  const seen = new Set<string>();
  for (const [i, raw] of input.entries()) {
    const rule = raw as EnrichmentRule;
    if (!rule || typeof rule !== 'object') return { ok: false, error: `Rule ${i + 1} is not an object.` };
    if (!rule.id?.trim()) return { ok: false, error: `Rule ${i + 1}: an id is required.` };
    if (seen.has(rule.id)) return { ok: false, error: `Duplicate rule id "${rule.id}".` };
    seen.add(rule.id);

    if (!rule.name?.trim()) return { ok: false, error: `Rule "${rule.id}": a name is required.` };
    if (typeof rule.priority !== 'number' || rule.priority < 1) {
      return { ok: false, error: `Rule "${rule.id}": priority must be a number ≥ 1.` };
    }
    if (!rule.volume || typeof rule.volume.dailyLimit !== 'number' || rule.volume.dailyLimit < 0) {
      return { ok: false, error: `Rule "${rule.id}": volume.dailyLimit must be a number ≥ 0.` };
    }
    if (!rule.action || typeof rule.action.enrich !== 'boolean') {
      return { ok: false, error: `Rule "${rule.id}": action.enrich must be true or false.` };
    }
    if (!['phone', 'email', 'both'].includes(rule.action.contactPriority)) {
      return { ok: false, error: `Rule "${rule.id}": contactPriority must be phone, email or both.` };
    }
    if (rule.conditions?.bands?.length) {
      const valid = ['P1', 'P2', 'P3', 'P4'];
      if (!rule.conditions.bands.every((b) => valid.includes(b))) {
        return { ok: false, error: `Rule "${rule.id}": bands must be a subset of P1–P4.` };
      }
    }
  }

  return { ok: true, rules: input as EnrichmentRule[] };
}
