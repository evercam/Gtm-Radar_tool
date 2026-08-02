import { isDeliverableWebhook } from '@/lib/enrich/webhookTarget';

/**
 * Enrichment policy — the admin-editable parameters that govern WHO gets
 * enriched, HOW MUCH gets spent, and WHICH engines run. Stored as a single
 * `enrichment_policy` row and edited on /control/enrichment, in the same
 * shape-with-defaults pattern as the routing and scoring policies.
 *
 * Enrichment costs money on every record (Claude + Apollo credits), so the
 * defaults here are deliberately conservative: a small batch, the strongest
 * records first, and no re-enriching anything touched in the last month.
 */

export interface EnrichmentPolicy {
  /** Engines allowed to run. Turning one off never fails a batch — it degrades. */
  engines: {
    claude: boolean;
    apollo: boolean;
    /** GLEIF is keyless and free — corporate hierarchy lookup. */
    gleif: boolean;
  };
  /** Default records per batch in the control centre. */
  batchSize: number;
  /** Hard ceiling a single batch may never exceed, whatever the UI asks for. */
  maxBatchSize: number;
  /** How many records are enriched in parallel. Keep low to respect rate limits. */
  concurrency: number;
  /** Records scoring below this are never auto-enriched. */
  minPriorityScore: number;
  /** Bands eligible for enrichment (empty = all). */
  bands: string[];
  /** Record types worth resolving an account for (empty = all). */
  recordTypes: string[];
  /** Business units eligible for enrichment (empty = all). */
  bus: string[];
  /** Verticals eligible for enrichment (empty = all). */
  verticals: string[];
  /**
   * Skip records below this value. Records with no value at all are skipped
   * too when this is above zero — an unpriced record cannot be shown to clear
   * the bar, and guessing in its favour is how budget leaks.
   */
  minEstimatedValue: number;
  /**
   * Skip records with no company name. Apollo resolves contacts from a company;
   * without one the call is spent to return nothing.
   */
  requireCompany: boolean;
  /** Skip a record enriched more recently than this many days ago. */
  reenrichAfterDays: number;
  /** Safety rail: most records the batch endpoint will process in 24h. */
  dailyCap: number;
  /** Safety rail over 30 days. 0 disables it. Applied alongside dailyCap. */
  monthlyCap: number;
  /** Apollo contacts requested per account. */
  contactsPerAccount: number;
  /**
   * Apollo seniority filter. Narrower means fewer, more senior contacts per
   * credit spent; empty means Apollo returns whoever it has.
   */
  contactSeniorities: string[];
  /**
   * Job titles to target when the source's enrichment profile has none of its
   * own. A profile's titles always win — they are tuned to that source.
   */
  fallbackTitles: string[];
  /**
   * Ask Apollo to reveal direct dials and mobiles. Off by default: this costs
   * 8 Apollo credits per number against 1 for a work email, and needs a public
   * HTTPS webhook for Apollo to deliver to.
   */
  revealPhoneNumbers: boolean;
  /** Where Apollo delivers revealed numbers. Must be public HTTPS. */
  phoneWebhookUrl: string;
  /** Most reveals per run. Each is 8 credits, so this is a spend rail, not a batch size. */
  maxPhoneRevealsPerRun: number;
  /**
   * Go back for the roles a first pass missed — a narrow Apollo search per
   * missing role, then Claude for whatever Apollo still cannot supply.
   *
   * Costs more per account than a single call, deliberately: a list missing
   * its economic buyer costs a BDR a week of calling people who cannot sign.
   */
  fillCommittee: boolean;
  /** Which list-quality standard to fill to. */
  committeeSize: 'enterprise' | 'mid_market';
  /** Contacts to request per missing role. */
  contactsPerRole: number;
  /**
   * What each lane needs before a lead can leave enrichment — the narrowest
   * gate in the pipeline. `any` accepts whichever channel validates.
   */
  channelRules: Record<string, 'phone' | 'email' | 'both' | 'any' | 'none'>;
  /**
   * Whether a lead must carry a validated phone/email for its lane before it
   * counts as workable.
   *
   * On, a record missing its channel stays queued rather than reaching a seller
   * who cannot act on it — which is right once contact details actually arrive.
   * Off, the lane requirement is ignored entirely, for the case where no
   * verification tool is connected AND the contact source does not return
   * addresses: Apollo's api_search reports only THAT an email exists, revealing
   * it is a separate credited call. Left on in that situation, nothing is ever
   * workable and the queue grows forever with no explanation.
   */
  requireChannel: boolean;
  /**
   * How many contact addresses may be revealed per enrichment run.
   *
   * Apollo's search says an email EXISTS; getting it is a separate call at one
   * credit each. So this is the real spend dial — `contactsPerAccount` decides
   * how many people are found, this decides how many become contactable. 0 turns
   * revealing off entirely, which leaves contacts with names and titles and
   * nothing to send to.
   */
  maxEmailRevealsPerRecord: number;
  /** Only enrich records that still have no contact. */
  onlyMissingContact: boolean;
  /**
   * Generate a Claude call-prep brief once a record is enriched. Separate from
   * `engines.claude` so the briefs can be turned off — they are the expensive
   * part — while Claude still resolves accounts.
   */
  generateCallPrep: boolean;
  /**
   * Ceiling on one export run — a safety rail, not the volume dial.
   *
   * How many leads each person receives comes from their own
   * `daily_lead_quota` on the roster, so this only stops a single run from
   * sending an unbounded number if a quota is misconfigured. Apollo's own API
   * caps a batch at 100 regardless.
   */
  apolloBatchSize: number;
  /**
   * Run Claude's deep account research INSIDE the enrichment batch.
   *
   * Off, because the arithmetic does not allow it: `batchSize` 10 at
   * `concurrency` 3 gives each record roughly 75 seconds of the route's
   * 300-second budget, and the research call — 16k tokens, adaptive thinking,
   * up to six web-search resumes — wants 150 or more on its own. Measured, it
   * timed out on every Cleveland-Cliffs record, and raising the ceiling only
   * converts "one brief missing" into "the batch dies mid-write".
   *
   * So enrichment does the part that makes a lead WORKABLE — domain, contacts,
   * revealed addresses, all of it Apollo — and the `brief` job does the part
   * that makes it well-briefed, a couple of records at a time with the whole
   * function to itself. Turn this on only if briefs must land in the same pass
   * as contacts and the research prompt has been shrunk to fit.
   */
  researchInline: boolean;
  /**
   * Enriched leads to produce each calendar month.
   *
   * A production FLOW, not a buffer depth — the distinction matters. A buffer
   * says "hold N in stock and stop"; this says "make N a month", which is what a
   * team consuming leads daily actually needs. At five people taking fifty a day
   * the team draws about 250 a day, so 7,200 a month keeps supply and demand
   * roughly level.
   *
   * Enrichment runs until the month's total is reached and then stops, so the
   * Apollo spend is bounded per month by a number somebody chose rather than by
   * how often a cron happened to fire.
   *
   * The per-person SPLIT of that total comes from each assignee's
   * `daily_lead_quota`, so who the leads are for is still decided by the roster.
   */
  monthlyReadyTarget: number;
}

export const DEFAULT_ENRICHMENT_POLICY: EnrichmentPolicy = {
  engines: { claude: true, apollo: true, gleif: true },
  batchSize: 10,
  maxBatchSize: 100,
  concurrency: 3,
  minPriorityScore: 35,
  bands: ['P1', 'P2'],
  recordTypes: ['project', 'tender', 'permit', 'account', 'filing'],
  bus: [],
  verticals: [],
  minEstimatedValue: 0,
  requireCompany: true,
  reenrichAfterDays: 30,
  dailyCap: 500,
  monthlyCap: 10000,
  contactsPerAccount: 5,
  contactSeniorities: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager'],
  fallbackTitles: [],
  revealPhoneNumbers: false,
  phoneWebhookUrl: '',
  maxPhoneRevealsPerRun: 10,
  fillCommittee: true,
  committeeSize: 'enterprise',
  contactsPerRole: 3,
  channelRules: { act_now: 'phone', qualify: 'phone', nurture: 'email' },
  requireChannel: true,
  maxEmailRevealsPerRecord: 3,
  onlyMissingContact: true,
  generateCallPrep: true,
  apolloBatchSize: 100,
  researchInline: false,
  monthlyReadyTarget: 7200,
};

/** Coerce a saved (possibly partial or stale) policy onto the defaults. */
export function mergeEnrichmentPolicy(input: unknown): EnrichmentPolicy {
  const d = DEFAULT_ENRICHMENT_POLICY;
  if (!input || typeof input !== 'object') return d;
  const p = input as Partial<EnrichmentPolicy>;

  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback;
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const strList = (v: unknown, fallback: string[]) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : fallback;

  const maxBatchSize = num(p.maxBatchSize, d.maxBatchSize, 1, 1000);
  return {
    engines: {
      claude: bool(p.engines?.claude, d.engines.claude),
      apollo: bool(p.engines?.apollo, d.engines.apollo),
      gleif: bool(p.engines?.gleif, d.engines.gleif),
    },
    batchSize: num(p.batchSize, d.batchSize, 1, maxBatchSize),
    maxBatchSize,
    concurrency: num(p.concurrency, d.concurrency, 1, 10),
    minPriorityScore: num(p.minPriorityScore, d.minPriorityScore, 0, 100),
    bands: strList(p.bands, d.bands),
    recordTypes: strList(p.recordTypes, d.recordTypes),
    bus: strList(p.bus, d.bus),
    verticals: strList(p.verticals, d.verticals),
    minEstimatedValue: num(p.minEstimatedValue, d.minEstimatedValue, 0, 1_000_000_000_000),
    requireCompany: bool(p.requireCompany, d.requireCompany),
    reenrichAfterDays: num(p.reenrichAfterDays, d.reenrichAfterDays, 0, 3650),
    dailyCap: num(p.dailyCap, d.dailyCap, 0, 100_000),
    monthlyCap: num(p.monthlyCap, d.monthlyCap, 0, 3_000_000),
    contactsPerAccount: num(p.contactsPerAccount, d.contactsPerAccount, 1, 25),
    contactSeniorities: strList(p.contactSeniorities, d.contactSeniorities),
    fallbackTitles: strList(p.fallbackTitles, d.fallbackTitles),
    revealPhoneNumbers: bool(p.revealPhoneNumbers, d.revealPhoneNumbers),
    phoneWebhookUrl: typeof p.phoneWebhookUrl === 'string' ? p.phoneWebhookUrl.trim() : d.phoneWebhookUrl,
    maxPhoneRevealsPerRun: num(p.maxPhoneRevealsPerRun, d.maxPhoneRevealsPerRun, 0, 500),
    fillCommittee: bool(p.fillCommittee, d.fillCommittee),
    committeeSize: p.committeeSize === 'mid_market' ? 'mid_market' : d.committeeSize,
    contactsPerRole: num(p.contactsPerRole, d.contactsPerRole, 1, 10),
    channelRules: (() => {
      const valid = ['phone', 'email', 'both', 'any', 'none'];
      const out = { ...d.channelRules };
      if (p.channelRules && typeof p.channelRules === 'object') {
        for (const [lane, ch] of Object.entries(p.channelRules)) {
          if (valid.includes(ch as string)) out[lane] = ch as EnrichmentPolicy['channelRules'][string];
        }
      }
      return out;
    })(),
    requireChannel: bool(p.requireChannel, d.requireChannel),
    maxEmailRevealsPerRecord: num(p.maxEmailRevealsPerRecord, d.maxEmailRevealsPerRecord, 0, 25),
    onlyMissingContact: bool(p.onlyMissingContact, d.onlyMissingContact),
    generateCallPrep: bool(p.generateCallPrep, d.generateCallPrep),
    apolloBatchSize: num(p.apolloBatchSize, d.apolloBatchSize, 1, 1000),
    researchInline: bool(p.researchInline, d.researchInline),
    monthlyReadyTarget: num(p.monthlyReadyTarget, d.monthlyReadyTarget, 0, 1_000_000),
  };
}

/** Validation for the admin editor — stricter than merge, with a reason. */
export function validateEnrichmentPolicy(
  input: unknown
): { ok: true; policy: EnrichmentPolicy } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, error: 'Policy must be an object.' };
  const p = input as Partial<EnrichmentPolicy>;

  if (p.engines && !p.engines.claude && !p.engines.apollo) {
    return { ok: false, error: 'At least one of the Claude or Apollo engines must stay enabled.' };
  }
  if (p.batchSize !== undefined && p.maxBatchSize !== undefined && p.batchSize > p.maxBatchSize) {
    return { ok: false, error: 'batchSize cannot exceed maxBatchSize.' };
  }
  for (const k of ['batchSize', 'maxBatchSize', 'concurrency', 'contactsPerAccount'] as const) {
    if (p[k] !== undefined && (typeof p[k] !== 'number' || (p[k] as number) < 1)) {
      return { ok: false, error: `${k} must be a number ≥ 1.` };
    }
  }
  for (const k of ['minPriorityScore', 'reenrichAfterDays', 'dailyCap', 'monthlyCap', 'minEstimatedValue'] as const) {
    if (p[k] !== undefined && (typeof p[k] !== 'number' || (p[k] as number) < 0)) {
      return { ok: false, error: `${k} must be a number ≥ 0.` };
    }
  }
  if (p.bands !== undefined) {
    const valid = ['P1', 'P2', 'P3', 'P4'];
    if (!Array.isArray(p.bands) || !p.bands.every((b) => valid.includes(b as string))) {
      return { ok: false, error: 'bands must be a subset of P1, P2, P3, P4.' };
    }
  }
  if (p.bands !== undefined && p.bands.length === 0) {
    return { ok: false, error: 'At least one priority band must stay eligible, or nothing is ever enriched.' };
  }
  if (p.recordTypes !== undefined && Array.isArray(p.recordTypes) && p.recordTypes.length === 0) {
    return { ok: false, error: 'At least one record type must stay eligible, or nothing is ever enriched.' };
  }
  if (p.dailyCap !== undefined && p.monthlyCap !== undefined && p.monthlyCap > 0 && p.dailyCap > p.monthlyCap) {
    return { ok: false, error: 'dailyCap cannot exceed monthlyCap — the monthly rail would never be reachable.' };
  }
  // Turning reveal on without somewhere to deliver spends credits on numbers
  // that can never arrive.
  if (p.revealPhoneNumbers && !isDeliverableWebhook(p.phoneWebhookUrl)) {
    return {
      ok: false,
      error:
        'Phone reveal needs a public HTTPS webhook URL Apollo can reach — Apollo delivers numbers asynchronously and cannot call localhost.',
    };
  }
  if (p.contactSeniorities !== undefined) {
    const valid = ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern'];
    if (!Array.isArray(p.contactSeniorities) || !p.contactSeniorities.every((x) => valid.includes(x as string))) {
      return { ok: false, error: `contactSeniorities must be a subset of: ${valid.join(', ')}.` };
    }
  }
  return { ok: true, policy: mergeEnrichmentPolicy(input) };
}
