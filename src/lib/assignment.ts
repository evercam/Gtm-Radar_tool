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

export interface AssignmentResult {
  assignments: Assignment[];
  /** Matched a rule but every candidate was at quota. */
  atCapacity: number;
  /** Matched no rule, or the rule's target had nobody eligible. */
  unassigned: number;
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

/**
 * Picks the user with the most remaining headroom, so load spreads evenly
 * rather than filling one person before touching the next. Ties break on the
 * larger quota, then on id for determinism.
 */
function pickLeastLoaded(candidates: AssignableUser[]): AssignableUser | null {
  const withCapacity = candidates.filter((u) => u.assignedToday < u.dailyQuota);
  if (withCapacity.length === 0) return null;

  return withCapacity.sort((a, b) => {
    const headroomA = a.dailyQuota - a.assignedToday;
    const headroomB = b.dailyQuota - b.assignedToday;
    if (headroomB !== headroomA) return headroomB - headroomA;
    if (b.dailyQuota !== a.dailyQuota) return b.dailyQuota - a.dailyQuota;
    return a.id.localeCompare(b.id);
  })[0];
}

/**
 * Assigns a batch of leads.
 *
 * Highest-priority leads are placed first, so when capacity runs out it is the
 * weakest leads that go unassigned — the same principle as the enrichment
 * selection. `assignedToday` is mutated as we go, so one pass cannot hand the
 * same person more than their quota.
 */
export function assignLeads(
  leads: AssignableLead[],
  rules: AssignmentRule[],
  users: AssignableUser[]
): AssignmentResult {
  const ordered = rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);
  // Work on copies so the caller's objects aren't mutated.
  const pool = users.map((u) => ({ ...u }));
  const byId = new Map(pool.map((u) => [u.id, u]));

  const assignments: Assignment[] = [];
  let atCapacity = 0;
  let unassigned = 0;

  const queue = [...leads]
    .filter((l) => !l.owner_user_id)
    .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));

  for (const lead of queue) {
    const rule = ordered.find((r) => matchesAssignment(lead, r));
    if (!rule) {
      unassigned += 1;
      continue;
    }

    let target: AssignableUser | null = null;

    if (rule.toUserId) {
      const user = byId.get(rule.toUserId);
      // A named target still has to cover the lead and have room — otherwise
      // the rule would quietly overload one person or hand them a lead
      // outside their scope.
      target =
        user && user.isActive && userCoversLead(user, lead) && user.assignedToday < user.dailyQuota ? user : null;
    } else if (rule.toRole) {
      target = pickLeastLoaded(pool.filter((u) => u.role === rule.toRole && userCoversLead(u, lead)));
    }

    if (!target) {
      atCapacity += 1;
      continue;
    }

    target.assignedToday += 1;
    assignments.push({ leadId: lead.id, userId: target.id, ruleId: rule.id, ruleName: rule.name });
  }

  return { assignments, atCapacity, unassigned };
}

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
    if (!rule.toUserId && !rule.toRole) {
      return { ok: false, error: `Rule "${rule.id}": needs either toUserId or toRole.` };
    }
    if (rule.toUserId && rule.toRole) {
      return { ok: false, error: `Rule "${rule.id}": set toUserId or toRole, not both.` };
    }
  }

  return { ok: true, rules: input as AssignmentRule[] };
}
