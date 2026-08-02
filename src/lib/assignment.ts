/**
 * Lead assignment.
 *
 * Decides which person owns a lead. Rules match on the record's shape and
 * target either a named user or a role; within a role the lead goes to
 * whoever is furthest below their daily quota, so work spreads instead of
 * piling onto whoever sorts first.
 *
 * Pure and deterministic like the other engines — candidates and rules in, an
 * assignment out. The caller does the reading and writing.
 */

export interface AssignmentConditions {
  bu?: string[];
  vertical?: string[];
  region?: string[];
  icp?: string[];
  recordTypes?: string[];
  bands?: string[];
  route?: string[];
  stage?: string[];
  minPriorityScore?: number;
  minValue?: number;
  /** Only leads that already carry a validated channel. */
  requiresContact?: boolean;
}

export interface AssignmentRule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  conditions: AssignmentConditions;
  /** Assign to this exact user, or to whoever in `toRole` has capacity. */
  toUserId?: string | null;
  toRole?: string | null;
}

/** A person who can receive leads. */
export interface AssignableUser {
  /** assignees.id — the roster entry, not an auth user. */
  id: string;
  /** Shown on the record and on the handoff sheet. */
  name?: string;
  /** The app account, when this person has one. Null for most of the roster. */
  userId?: string | null;
  role: string;
  bu: string[];
  verticals: string[];
  regions: string[];
  dailyQuota: number;
  /** How many they already hold today. */
  assignedToday: number;
  isActive: boolean;
  /**
   * Verticals this person would rather work. A preference, not a filter —
   * `verticals` is the hard scope; this only breaks ties between people who
   * are equally free, so an account stays with whoever is building it.
   */
  preferredVerticals?: string[];
}

export interface AssignableLead {
  id: string;
  bu: string | null;
  vertical: string | null;
  country: string | null;
  icp_code: string | null;
  record_type: string | null;
  priority_band: string | null;
  priority_score: number | null;
  estimated_value: number | null;
  route: string | null;
  stage: string | null;
  contact_status: string | null;
  owner_user_id: string | null;
  /** Who owns it. Set even when the owner has no app account. */
  assigneeId?: string | null;
  /** Which feed it came from — one of the dimensions a mix can be declared against. */
  source_key?: string | null;
}

export interface Assignment {
  leadId: string;
  userId: string;
  ruleId: string;
  ruleName: string;
}

export const DEFAULT_ASSIGNMENT_RULES: AssignmentRule[] = [
  {
    id: 'hot_to_sdr',
    name: 'Act Now leads to SDRs',
    priority: 1,
    enabled: true,
    conditions: { stage: ['act_now'], requiresContact: true },
    toRole: 'sdr',
  },
  {
    id: 'qualified_to_ae',
    name: 'Qualified leads to Account Executives',
    priority: 2,
    enabled: true,
    conditions: { stage: ['qualify'], bands: ['P1', 'P2'], requiresContact: true },
    toRole: 'ae',
  },
  {
    id: 'nurture_to_marketing',
    name: 'Nurture to Marketing',
    priority: 3,
    enabled: true,
    conditions: { stage: ['nurture'] },
    toRole: 'marketing',
  },
  {
    id: 'rest_to_bdr',
    name: 'Everything else to BDRs',
    priority: 4,
    enabled: true,
    conditions: { requiresContact: true },
    toRole: 'bdr',
  },
];

const inList = (value: string | null, list?: string[]): boolean => {
  if (!list || list.length === 0) return true;
  return value != null && list.includes(value);
};

export function matchesAssignment(lead: AssignableLead, rule: AssignmentRule): boolean {
  const c = rule.conditions;
  if (!inList(lead.bu, c.bu)) return false;
  if (!inList(lead.vertical, c.vertical)) return false;
  if (!inList(lead.country, c.region)) return false;
  if (!inList(lead.icp_code, c.icp)) return false;
  if (!inList(lead.record_type, c.recordTypes)) return false;
  if (!inList(lead.priority_band, c.bands)) return false;
  if (!inList(lead.route, c.route)) return false;
  if (!inList(lead.stage, c.stage)) return false;
  if (c.minPriorityScore !== undefined && (lead.priority_score ?? 0) < c.minPriorityScore) return false;
  if (c.minValue !== undefined && (lead.estimated_value ?? 0) < c.minValue) return false;
  if (c.requiresContact && lead.contact_status !== 'has_contact') return false;
  return true;
}

/**
 * Whether a user's scope covers a lead.
 *
 * An empty scope array means "no restriction on this axis" rather than "match
 * nothing" — otherwise a newly invited user with no scope set would silently
 * receive nothing and look broken.
 */
export function userCoversLead(user: AssignableUser, lead: AssignableLead): boolean {
  if (!user.isActive) return false;
  if (user.bu.length > 0 && (!lead.bu || !user.bu.includes(lead.bu))) return false;
  if (user.verticals.length > 0 && (!lead.vertical || !user.verticals.includes(lead.vertical))) return false;
  if (user.regions.length > 0 && (!lead.country || !user.regions.includes(lead.country))) return false;
  return true;
}

/*
 * `assignLeads` and its `pickLeastLoaded` helper lived here and were deleted.
 *
 * Nothing imported them. The engine the app actually runs is `planAllocation`
 * in lib/allocation.ts, which uses the primitives below — `matchesAssignment`
 * and `userCoversLead` — and adds the mix/share policy and the roster fallback.
 *
 * They were not merely unused, they were WRONG in a way that mattered: a lead
 * matching no rule was counted as `unassigned` and dropped, whereas
 * planAllocation falls back to anyone on the roster who covers it. That
 * fallback is the whole point of the current design — leads flow as soon as a
 * person exists — so the dead function taught the opposite of the shipped
 * behaviour to anyone reading this file first, which is the file you would read
 * first.
 */

/** Validation for the admin editor. */
export function validateAssignmentRules(
  input: unknown
): { ok: true; rules: AssignmentRule[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'Rules must be an array.' };

  const seen = new Set<string>();
  for (const [i, raw] of input.entries()) {
    const rule = raw as AssignmentRule;
    if (!rule || typeof rule !== 'object') return { ok: false, error: `Rule ${i + 1} is not an object.` };
    if (!rule.id?.trim()) return { ok: false, error: `Rule ${i + 1}: an id is required.` };
    if (seen.has(rule.id)) return { ok: false, error: `Duplicate rule id "${rule.id}".` };
    seen.add(rule.id);
    if (!rule.name?.trim()) return { ok: false, error: `Rule "${rule.id}": a name is required.` };
    if (typeof rule.priority !== 'number' || rule.priority < 1) {
      return { ok: false, error: `Rule "${rule.id}": priority must be a number ≥ 1.` };
    }
    // Naming neither a person nor a role is legal and means "anyone on the
    // roster whose scope covers it" — see ROSTER_FALLBACK_RULE in allocation.ts.
    // It used to be refused, back when a targetless rule resolved to no
    // recipient and assigned nothing.
    if (rule.toUserId && rule.toRole) {
      return { ok: false, error: `Rule "${rule.id}": set toUserId or toRole, not both.` };
    }
  }

  return { ok: true, rules: input as AssignmentRule[] };
}
