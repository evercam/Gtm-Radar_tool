/**
 * Routing / disposition engine. Admin-defined, first-match rules split every
 * record into a lane: who owns it (route) and what to do (stage). Pure and
 * deterministic — the same function powers the dry-run preview and (later) the
 * materialized re-route pass.
 */

export type Route = 'sales' | 'marketing' | 'partner' | 'none';
export type Stage = 'act_now' | 'qualify' | 'nurture' | 'hold' | 'disqualify';

export interface RoutingMatch {
  record_type?: string[];
  bu?: string[];
  icp?: string[];
  vertical?: string[];
  country?: string[];
  keyAccount?: boolean;
  contactStatus?: 'has_contact' | 'needs_enrichment';
  /** Key-account score (from account_enrichment), not lead priority. */
  minScore?: number;
  maxScore?: number;
  minCompleteness?: number;
  /** Lead priority score, 0..100 — see lib/priority.ts. */
  minPriority?: number;
  maxPriority?: number;
  /** Priority bands the record must be in, e.g. ["P1","P2"]. */
  priorityBands?: string[];
}
export interface RoutingAssign {
  route: Route;
  stage: Stage;
  team?: string; // literal, or "$bu" to use the record's BU
  sla_hours?: number;
}
export interface RoutingRule {
  name: string;
  enabled?: boolean;
  match: RoutingMatch;
  assign: RoutingAssign;
}

export interface RoutableRecord {
  bu: string | null;
  icp_code: string | null;
  vertical: string | null;
  record_type: string | null;
  contact_status: string | null;
  population_percentage: number | null;
  country: string | null;
  key_account: boolean;
  key_account_score: number | null;
  /** Lead priority, scored just before routing so rules can lane on it. */
  priority_score?: number | null;
  priority_band?: string | null;
}

export interface Disposition {
  route: Route;
  stage: Stage;
  team: string | null;
  reason: string; // the rule that fired
}

export const DEFAULT_DISPOSITION: Disposition = { route: 'marketing', stage: 'nurture', team: null, reason: 'default' };

/**
 * Sensible starter rules (first-match, top to bottom). Editable in /routing,
 * where the thresholds below are parameters, not code.
 *   • dead/backlog records (P4) are parked before anything else looks at them
 *   • news/signals → marketing awareness
 *   • key account + has contact → hot SDR queue
 *   • P1 with a contact → act now regardless of account status
 *   • key account or P1 without a contact → sales, but enrich first
 *   • anyone with a contact → sales to qualify
 *   • strong-but-cold → marketing nurture; everything else → default nurture
 */
export const DEFAULT_RULES: RoutingRule[] = [
  { name: 'Park — backlog priority', match: { priorityBands: ['P4'] }, assign: { route: 'none', stage: 'hold' } },
  {
    name: 'Awareness — news & signals',
    match: { record_type: ['news', 'signal'] },
    assign: { route: 'marketing', stage: 'nurture' },
  },
  {
    name: 'Hot — key account with contact',
    match: { keyAccount: true, contactStatus: 'has_contact' },
    assign: { route: 'sales', stage: 'act_now', team: '$bu', sla_hours: 8 },
  },
  {
    name: 'Hot — P1 priority with contact',
    match: { priorityBands: ['P1'], contactStatus: 'has_contact' },
    assign: { route: 'sales', stage: 'act_now', team: '$bu', sla_hours: 8 },
  },
  {
    name: 'Key account — enrich then act',
    match: { keyAccount: true, contactStatus: 'needs_enrichment' },
    assign: { route: 'sales', stage: 'qualify', team: '$bu' },
  },
  {
    name: 'P1 — enrich then act',
    match: { priorityBands: ['P1'], contactStatus: 'needs_enrichment' },
    assign: { route: 'sales', stage: 'qualify', team: '$bu' },
  },
  {
    name: 'Has contact — qualify',
    match: { contactStatus: 'has_contact' },
    assign: { route: 'sales', stage: 'qualify', team: '$bu' },
  },
  {
    name: 'Warm — P2 needs enrichment',
    match: { priorityBands: ['P2'], contactStatus: 'needs_enrichment' },
    assign: { route: 'marketing', stage: 'nurture' },
  },
];

function inList(v: string | null, list?: string[]): boolean {
  if (!list || list.length === 0) return true;
  return v != null && list.includes(v);
}

function matches(rec: RoutableRecord, m: RoutingMatch): boolean {
  if (!inList(rec.record_type, m.record_type)) return false;
  if (!inList(rec.bu, m.bu)) return false;
  if (!inList(rec.icp_code, m.icp)) return false;
  if (!inList(rec.vertical, m.vertical)) return false;
  if (!inList(rec.country, m.country)) return false;
  if (m.keyAccount !== undefined && Boolean(rec.key_account) !== m.keyAccount) return false;
  if (m.contactStatus && rec.contact_status !== m.contactStatus) return false;
  if (m.minScore !== undefined && (rec.key_account_score ?? 0) < m.minScore) return false;
  if (m.maxScore !== undefined && (rec.key_account_score ?? 0) > m.maxScore) return false;
  if (m.minCompleteness !== undefined && (rec.population_percentage ?? 0) < m.minCompleteness) return false;
  if (m.minPriority !== undefined && (rec.priority_score ?? 0) < m.minPriority) return false;
  if (m.maxPriority !== undefined && (rec.priority_score ?? 0) > m.maxPriority) return false;
  if (m.priorityBands?.length && !(rec.priority_band && m.priorityBands.includes(rec.priority_band))) return false;
  return true;
}

/** Evaluate a record against the ordered rules → its disposition (first match wins). */
export function route(rec: RoutableRecord, rules: RoutingRule[]): Disposition {
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (matches(rec, rule.match)) {
      const team = rule.assign.team === '$bu' ? rec.bu : (rule.assign.team ?? null);
      return { route: rule.assign.route, stage: rule.assign.stage, team, reason: rule.name };
    }
  }
  return { ...DEFAULT_DISPOSITION };
}

/** Basic validation for admin-edited rules (used by the save endpoint). */
export function validateRules(input: unknown): { ok: true; rules: RoutingRule[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'Rules must be an array.' };
  const ROUTES = ['sales', 'marketing', 'partner', 'none'];
  const STAGES = ['act_now', 'qualify', 'nurture', 'hold', 'disqualify'];
  for (const [i, r] of input.entries()) {
    const rule = r as RoutingRule;
    if (!rule || typeof rule.name !== 'string') return { ok: false, error: `Rule ${i + 1}: missing name.` };
    if (!rule.match || typeof rule.match !== 'object')
      return { ok: false, error: `Rule "${rule.name}": missing match.` };
    if (!rule.assign || !ROUTES.includes(rule.assign.route))
      return { ok: false, error: `Rule "${rule.name}": invalid route.` };
    if (!STAGES.includes(rule.assign.stage)) return { ok: false, error: `Rule "${rule.name}": invalid stage.` };
    const BANDS = ['P1', 'P2', 'P3', 'P4'];
    if (rule.match.priorityBands && !rule.match.priorityBands.every((b) => BANDS.includes(b))) {
      return { ok: false, error: `Rule "${rule.name}": priorityBands must be a subset of P1, P2, P3, P4.` };
    }
    for (const k of ['minPriority', 'maxPriority'] as const) {
      const v = rule.match[k];
      if (v !== undefined && (typeof v !== 'number' || v < 0 || v > 100)) {
        return { ok: false, error: `Rule "${rule.name}": ${k} must be between 0 and 100.` };
      }
    }
  }
  return { ok: true, rules: input as RoutingRule[] };
}
