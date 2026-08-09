/**
 * How the day's leads are divided up.
 *
 * Quotas answer "how many does each person get". This answers the question
 * underneath it: **which** leads. Assigning strictly by priority score sounds
 * fair and is not — whichever vertical happens to score highest takes the
 * whole day, and a book that is 34% bioenergy by volume can deliver a week of
 * nothing but bioenergy. Sellers then lose the accounts they were building.
 *
 * So a target mix can be declared as shares — 40% data centre, 30% energy,
 * whatever the business wants — and the allocator honours it while still
 * preferring the strongest lead inside each share.
 *
 * Pure and deterministic, like the routing and scoring engines: leads, rules,
 * people and a policy in, a plan out. The caller does the reading and writing.
 */

import type { AssignableLead, AssignableUser, AssignmentRule, Assignment } from '@/lib/assignment';
import { matchesAssignment, userCoversLead } from '@/lib/assignment';

/** What a share can be declared against. */
export type MixDimension = 'vertical' | 'source' | 'region' | 'band';

export interface AllocationPolicy {
  /**
   * `priority` ignores the mix entirely and works strictly best-first.
   * `mix` caps each bucket at its share of the day before falling back to
   * priority for whatever capacity is left.
   */
  mode: 'priority' | 'mix';
  /** Which attribute the shares are declared against. */
  dimension: MixDimension;
  /**
   * Bucket → percentage of the day's capacity, 0–100.
   *
   * These are percentages, not relative weights: 40/30/30 claims 100% of the
   * day, while 4/3/3 claims 10% and leaves the rest to be split among the
   * buckets nobody named. That is deliberate — it lets a policy pin one
   * vertical at 20% without having to state a number for every other one.
   * Validation rejects a total above 100.
   */
  shares: Record<string, number>;
  /** Most leads to assign in one run. Null means only the quotas bind. */
  dailyCap: number | null;
  /**
   * Whether a lead may still be assigned when its bucket is full and capacity
   * remains. Off keeps the mix exact at the cost of leaving people idle.
   */
  fillRemainder: boolean;
}

export const DEFAULT_ALLOCATION: AllocationPolicy = {
  mode: 'priority',
  dimension: 'vertical',
  shares: {},
  dailyCap: null,
  fillRemainder: true,
};

export interface BucketReport {
  bucket: string;
  /** Share of the plan this bucket was meant to take, 0–1. */
  targetShare: number;
  /** Leads the target allowed. */
  target: number;
  /** Leads actually assigned. */
  assigned: number;
  /** Leads of this bucket available and matched by a rule. */
  available: number;
}

export interface AllocationResult {
  assignments: Assignment[];
  /** Matched a rule, somebody's scope covers it, but they are all at quota. */
  atCapacity: number;
  /**
   * Matched a rule, and NOBODY's scope covers it — no active assignee works that
   * business unit, vertical or region.
   *
   * Split out from `atCapacity`, which used to absorb both. They look identical
   * in a total and point at opposite fixes: capacity is solved by raising a
   * quota, coverage only by activating or re-scoping somebody. Live, all 276 NHS
   * leads reported as "at capacity" when the real cause was that the single
   * active assignee covers `usa` and every one of those leads is `uk` — raising
   * quotas would have changed nothing.
   */
  noCoverage: number;
  /** Matched no rule at all. */
  unassigned: number;
  /** Held back because their bucket had already taken its share. */
  heldForMix: number;
  buckets: BucketReport[];
}

function bucketOf(lead: AssignableLead, dimension: MixDimension): string {
  switch (dimension) {
    case 'vertical':
      return lead.vertical ?? 'unknown';
    case 'source':
      return lead.source_key ?? 'unknown';
    case 'region':
      return lead.country ?? 'unknown';
    case 'band':
      return lead.priority_band ?? 'unscored';
  }
}

/**
 * Total room across everyone, which is what a share is a share OF. Using the
 * lead count instead would promise a mix the team has no capacity to work.
 */
function totalCapacity(users: AssignableUser[], dailyCap: number | null): number {
  const headroom = users
    .filter((u) => u.isActive)
    .reduce((n, u) => n + Math.max(0, u.dailyQuota - u.assignedToday), 0);
  return dailyCap === null ? headroom : Math.min(headroom, Math.max(0, dailyCap));
}

/**
 * Whoever has the most room, then the larger quota, then id — so the result is
 * stable rather than dependent on row order. A preference for the lead's
 * vertical breaks ties first: it costs nothing when nobody has a preference,
 * and keeps an account with the person building it when somebody does.
 */
function pick(candidates: AssignableUser[], lead: AssignableLead): AssignableUser | null {
  const withRoom = candidates.filter((u) => u.assignedToday < u.dailyQuota);
  if (withRoom.length === 0) return null;

  const prefers = (u: AssignableUser) =>
    lead.vertical && u.preferredVerticals?.includes(lead.vertical) ? 1 : 0;

  return withRoom.sort((a, b) => {
    const pa = prefers(a);
    const pb = prefers(b);
    if (pa !== pb) return pb - pa;
    const ra = a.dailyQuota - a.assignedToday;
    const rb = b.dailyQuota - b.assignedToday;
    if (rb !== ra) return rb - ra;
    if (b.dailyQuota !== a.dailyQuota) return b.dailyQuota - a.dailyQuota;
    return a.id.localeCompare(b.id);
  })[0];
}

/**
 * Turn declared shares into a lead count per bucket.
 *
 * Buckets present in the data but absent from the policy split whatever the
 * named shares leave, so adding one named share does not silently starve
 * everything else.
 */
function targetsFor(
  policy: AllocationPolicy,
  capacity: number,
  present: Map<string, number>
): Map<string, number> {
  const targets = new Map<string, number>();
  if (capacity <= 0) return targets;

  const named = Object.entries(policy.shares).filter(([, w]) => w > 0);
  if (named.length === 0) return targets;

  let allocated = 0;
  for (const [bucket, percent] of named) {
    const n = Math.floor(capacity * (Math.min(100, percent) / 100));
    targets.set(bucket, n);
    allocated += n;
  }

  const others = [...present.keys()].filter((b) => !targets.has(b));
  const leftover = Math.max(0, capacity - allocated);
  if (others.length > 0 && leftover > 0) {
    const each = Math.floor(leftover / others.length);
    for (const b of others) targets.set(b, each);
  }

  return targets;
}

/**
 * The rule that applies when no authored rule does.
 *
 * Being on the roster is what makes someone assignable, so a lead nobody wrote a
 * rule for still goes to whoever on the roster covers it and has the most room.
 * Without this, a roster full of people and an empty rule list assigned nothing
 * and said "matched no rule", which reads as a bug and was the most common state
 * a new install sat in.
 *
 * It runs LAST and only on leftovers, so an authored rule always wins: the
 * fallback widens who gets work, never redirects it. Scope and quota still bind —
 * `userCoversLead` and `dailyQuota` are checked the same way as for any rule —
 * so this hands nobody a lead outside their patch or beyond their limit.
 */
export const ROSTER_FALLBACK_RULE: AssignmentRule = {
  id: 'roster_fallback',
  name: 'Anyone on the roster who covers it',
  priority: Number.MAX_SAFE_INTEGER,
  enabled: true,
  conditions: {},
  toRole: null,
  toUserId: null,
};

export function planAllocation(
  leads: AssignableLead[],
  rules: AssignmentRule[],
  users: AssignableUser[],
  policy: AllocationPolicy = DEFAULT_ALLOCATION
): AllocationResult {
  const ordered = [
    ...rules.filter((r) => r.enabled !== false).sort((a, b) => a.priority - b.priority),
    ROSTER_FALLBACK_RULE,
  ];
  const pool = users.filter((u) => u.isActive).map((u) => ({ ...u }));
  const byId = new Map(pool.map((u) => [u.id, u]));

  const queue = [...leads]
    .filter((l) => !l.assigneeId && !l.owner_user_id)
    .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));

  const capacity = totalCapacity(pool, policy.dailyCap);

  // What is actually in the pool, so shares are reported against reality
  // rather than against a bucket list somebody typed months ago.
  const present = new Map<string, number>();
  for (const lead of queue) {
    if (!ordered.some((r) => matchesAssignment(lead, r))) continue;
    const b = bucketOf(lead, policy.dimension);
    present.set(b, (present.get(b) ?? 0) + 1);
  }

  const enforcing = policy.mode === 'mix' && Object.values(policy.shares).some((w) => w > 0);
  const targets = enforcing ? targetsFor(policy, capacity, present) : new Map<string, number>();
  const taken = new Map<string, number>();

  const assignments: Assignment[] = [];
  const deferred: AssignableLead[] = [];
  let atCapacity = 0;
  let noCoverage = 0;
  let unassigned = 0;
  let heldForMix = 0;

  /** The recipient a single rule resolves to for this lead, or null. */
  const targetFor = (rule: AssignmentRule, lead: AssignableLead): AssignableUser | null =>
    rule.toUserId
      ? (() => {
          const u = byId.get(rule.toUserId!);
          return u && u.isActive && userCoversLead(u, lead) && u.assignedToday < u.dailyQuota ? u : null;
        })()
      : rule.toRole
        ? pick(
            pool.filter((u) => u.role === rule.toRole && userCoversLead(u, lead)),
            lead
          )
        : // Neither a person nor a role named: anyone on the roster whose scope
          // covers the lead. This used to resolve to null, so a rule with
          // conditions and no recipient silently assigned nothing — and it is
          // what makes ROSTER_FALLBACK_RULE work without a special case.
          pick(
            pool.filter((u) => userCoversLead(u, lead)),
            lead
          );

  const give = (lead: AssignableLead): 'assigned' | 'at-capacity' | 'no-coverage' => {
    /*
      EVERY matching rule is tried, in order — not just the first.

      Taking only the first match meant a rule whose named recipient could not
      take the lead dropped it, instead of letting a later rule or the roster
      fallback place it. Held against the live config that was not a corner case:
      the top rule targets one BDR whose vertical scope excludes `construction`,
      which is 30,477 of 54,346 records, so every act-now construction lead
      matched that rule, failed its recipient check, and ended up with no owner at
      all — while the fallback would have placed it immediately.

      The precedence a rule list is supposed to express is "prefer this
      recipient", not "and if they cannot, nobody". An authored rule still wins
      whenever it CAN be satisfied, because the loop stops at the first rule that
      actually resolves.
    */
    let rule: AssignmentRule | null = null;
    let target: AssignableUser | null = null;
    for (const candidate of ordered) {
      if (!matchesAssignment(lead, candidate)) continue;
      const resolved = targetFor(candidate, lead);
      if (resolved) {
        rule = candidate;
        target = resolved;
        break;
      }
    }

    if (!target || !rule) {
      /*
        WHY nobody took it, not merely that nobody did.

        `userCoversLead` ignores quota, so asking it separately distinguishes
        "everyone who could take this is full" from "nobody works this kind of
        lead at all". The two send an operator to different levers.
      */
      return pool.some((u) => userCoversLead(u, lead)) ? 'at-capacity' : 'no-coverage';
    }
    target.assignedToday += 1;
    const b = bucketOf(lead, policy.dimension);
    taken.set(b, (taken.get(b) ?? 0) + 1);
    assignments.push({ leadId: lead.id, userId: target.id, ruleId: rule.id, ruleName: rule.name });
    return 'assigned';
  };

  for (const lead of queue) {
    if (policy.dailyCap !== null && assignments.length >= policy.dailyCap) break;
    if (!ordered.some((r) => matchesAssignment(lead, r))) {
      unassigned += 1;
      continue;
    }

    if (enforcing) {
      const b = bucketOf(lead, policy.dimension);
      const limit = targets.get(b) ?? 0;
      if ((taken.get(b) ?? 0) >= limit) {
        // Its share is spent. Held rather than dropped: if capacity survives
        // the first pass it is better used than left idle.
        deferred.push(lead);
        continue;
      }
    }

    const outcome = give(lead);
    if (outcome === 'at-capacity') atCapacity += 1;
    else if (outcome === 'no-coverage') noCoverage += 1;
  }

  if (enforcing && policy.fillRemainder) {
    for (const lead of deferred) {
      if (policy.dailyCap !== null && assignments.length >= policy.dailyCap) break;
      const outcome = give(lead);
      if (outcome === 'at-capacity') atCapacity += 1;
      else if (outcome === 'no-coverage') noCoverage += 1;
    }
  } else {
    heldForMix = deferred.length;
  }

  const bucketNames = new Set([...present.keys(), ...targets.keys()]);
  const buckets: BucketReport[] = [...bucketNames]
    .map((bucket) => ({
      bucket,
      targetShare: capacity > 0 ? (targets.get(bucket) ?? 0) / capacity : 0,
      target: targets.get(bucket) ?? 0,
      assigned: taken.get(bucket) ?? 0,
      available: present.get(bucket) ?? 0,
    }))
    .sort((a, b) => b.available - a.available);

  return { assignments, atCapacity, noCoverage, unassigned, heldForMix, buckets };
}

/** Coerce a saved (possibly partial or stale) policy onto the defaults. */
export function mergeAllocationPolicy(input: unknown): AllocationPolicy {
  const d = DEFAULT_ALLOCATION;
  if (!input || typeof input !== 'object') return d;
  const p = input as Partial<AllocationPolicy>;

  const shares: Record<string, number> = {};
  if (p.shares && typeof p.shares === 'object') {
    for (const [k, v] of Object.entries(p.shares)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) shares[k] = Math.min(100, v);
    }
  }

  return {
    mode: p.mode === 'mix' ? 'mix' : 'priority',
    dimension: (['vertical', 'source', 'region', 'band'] as const).includes(p.dimension as MixDimension)
      ? (p.dimension as MixDimension)
      : d.dimension,
    shares,
    dailyCap:
      typeof p.dailyCap === 'number' && Number.isFinite(p.dailyCap) && p.dailyCap > 0
        ? Math.min(100_000, Math.round(p.dailyCap))
        : null,
    fillRemainder: typeof p.fillRemainder === 'boolean' ? p.fillRemainder : d.fillRemainder,
  };
}

/** Validation for the editor — stricter than merge, with a reason. */
export function validateAllocationPolicy(
  input: unknown
): { ok: true; policy: AllocationPolicy } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Policy must be an object.' };
  }
  const p = input as Partial<AllocationPolicy>;
  const shares = p.shares && typeof p.shares === 'object' ? p.shares : {};

  for (const [bucket, weight] of Object.entries(shares)) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      return { ok: false, error: `Share for "${bucket}" must be a number of 0 or more.` };
    }
  }
  const total = Object.values(shares).reduce((n, w) => n + (typeof w === 'number' ? w : 0), 0);
  if (total > 100) {
    return { ok: false, error: `Shares total ${Math.round(total)}% — they cannot exceed 100%.` };
  }
  // Enforcing a mix with nothing declared would hold back every lead.
  if (p.mode === 'mix' && total <= 0) {
    return { ok: false, error: 'Enforcing a mix needs at least one share above zero.' };
  }

  if (p.dailyCap !== undefined && p.dailyCap !== null) {
    if (typeof p.dailyCap !== 'number' || p.dailyCap < 1) {
      return { ok: false, error: 'The daily cap must be a number of 1 or more, or left off.' };
    }
  }

  return { ok: true, policy: mergeAllocationPolicy(input) };
}

/** What was saved, in words. */
export function describeAllocation(p: AllocationPolicy): string {
  if (p.mode === 'priority') {
    return p.dailyCap
      ? `Saved — strongest leads first, up to ${p.dailyCap.toLocaleString()} a day.`
      : 'Saved — strongest leads first, limited only by each person\u2019s quota.';
  }
  const named = Object.entries(p.shares)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([b, w]) => `${Math.round(w)}% ${b.replace(/_/g, ' ')}`);
  const cap = p.dailyCap ? `, up to ${p.dailyCap.toLocaleString()} a day` : '';
  return `Saved — targeting ${named.join(', ')} by ${p.dimension}${cap}.`;
}
