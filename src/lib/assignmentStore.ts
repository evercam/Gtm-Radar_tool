import 'server-only';
import {
  DEFAULT_ALLOCATION,
  mergeAllocationPolicy,
  validateAllocationPolicy,
  describeAllocation,
  type AllocationPolicy,
} from '@/lib/allocation';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import {


  DEFAULT_ASSIGNMENT_RULES,
  validateAssignmentRules,
  type AssignmentRule,
  type AssignableUser,
} from '@/lib/assignment';

/**
 * Configuration reads go through the service role, not the caller's session.
 *
 * These tables are not scoped to a person — their policies say "any signed-in
 * user may read", and the pages that render them are permission-gated already.
 * Routing them through the request client made them depend on a PostgREST
 * token this app can no longer mint, so they silently returned nothing: a
 * roster entry would save correctly and then not appear.
 *
 * `canonical_projects` is deliberately NOT in this group. That data IS scoped
 * per user, and it waits for the direct-Postgres path in lib/db/pool.ts rather
 * than being widened to the service role.
 */
const configReader = () => getServiceSupabase();

/**
 * Reading and writing lead ownership.
 *
 * Ownership changes always go through `reassignLead` so the history table is
 * appended to — overwriting `owner_user_id` directly loses who held it and
 * why it moved, which is the first thing a manager asks when a lead stalls.
 */

export async function getAssignmentRules(): Promise<{ rules: AssignmentRule[]; isDefault: boolean }> {
  try {
    const { data, error } = await (
      configReader()
    )
      .from('assignment_rules')
      .select('rules')
      .eq('id', 'default')
      .maybeSingle();

    if (error || !data?.rules || !Array.isArray(data.rules) || data.rules.length === 0) {
      return { rules: DEFAULT_ASSIGNMENT_RULES, isDefault: true };
    }
    return { rules: data.rules as AssignmentRule[], isDefault: false };
  } catch {
    return { rules: DEFAULT_ASSIGNMENT_RULES, isDefault: true };
  }
}

export async function saveAssignmentRules(input: unknown): Promise<{ ok: boolean; message: string }> {
  if (!isSupabaseServiceConfigured()) return { ok: false, message: 'Supabase service role is not configured.' };

  const validated = validateAssignmentRules(input);
  if (!validated.ok) return { ok: false, message: validated.error };

  // A rule naming somebody by id who is not on the roster can never assign
  // anything, and nothing anywhere says so: the pass simply matches no target
  // and reports a successful run that moved nothing. This is how the shipped
  // "Act Now leads to the admin" rule came to point at 2544d9da, an id present
  // in neither `assignees` nor `user_profiles` — someone was removed from the
  // roster and re-added, which mints a new id.
  //
  // Refused rather than warned, because the rule is inert either way and a
  // refusal is the only version that gets fixed. `toRole` is NOT checked the
  // same way: a role nobody holds yet is a legitimate thing to plan for, and
  // the setup checklist already reports it.
  const targetedIds = [...new Set(validated.rules.map((r) => r.toUserId).filter((x): x is string => Boolean(x)))];
  if (targetedIds.length > 0) {
    const { rows: roster, tableMissing } = await getRoster();
    // Skip the check entirely if the roster table is missing — that is a
    // migration problem, and blocking rule edits on it would help nobody.
    if (!tableMissing && roster.length > 0) {
      const known = new Set(roster.filter((p) => p.is_active).map((p) => p.id));
      const unknown = validated.rules.filter((r) => r.toUserId && !known.has(r.toUserId));
      if (unknown.length > 0) {
        const names = unknown.map((r) => `“${r.name}”`).join(', ');
        return {
          ok: false,
          message: `${names} ${unknown.length === 1 ? 'targets' : 'target'} someone who is not on the active roster. Pick a recipient from the roster, or remove the rule.`,
        };
      }
    }
  }

  const { error } = await getServiceSupabase()
    .from('assignment_rules')
    .upsert({ id: 'default', rules: validated.rules }, { onConflict: 'id' });

  if (error) {
    const hint = /schema cache|does not exist/i.test(error.message) ? ' Run the assignment migration first.' : '';
    return { ok: false, message: `${error.message}.${hint}` };
  }
  return {
    ok: true,
    message: `Saved ${validated.rules.length} assignment rule${validated.rules.length === 1 ? '' : 's'}.`,
  };
}

/**
 * Everyone who can receive leads, with today's load already counted.
 *
 * The load is counted from `owner_assigned_at` rather than a stored counter so
 * it cannot drift — a counter would need resetting at midnight and would be
 * wrong after any manual reassignment.
 */
export async function getAssignableUsers(): Promise<{ users: AssignableUser[]; unavailable: string | null }> {
  if (!isSupabaseServiceConfigured()) return { users: [], unavailable: 'Supabase service role is not configured.' };

  try {
    const service = getServiceSupabase();
    // The roster, not the app's user accounts: most people who receive leads
    // never log in, and requiring an invitation to own a record was the wrong
    // shape for how this runs.
    const { data: profiles, error } = await service
      .from('assignees')
      .select('id, name, role, bu, verticals, regions, daily_lead_quota, preferred_verticals, is_active, user_id')
      .eq('is_active', true);
    /*
      An empty roster and a failed roster read are opposite problems.

      `api/leads` answers "No active users are available to receive leads" on a
      zero-length result, which is correct advice for an empty roster and sends
      somebody to check a roster that is perfectly fine when the read merely timed
      out. Distinguished rather than guessed.
    */
    if (error) return { users: [], unavailable: `roster could not be read: ${error.message}` };

    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const { data: todays, error: loadError } = await service
      .from('canonical_projects')
      .select('assignee_id')
      .not('assignee_id', 'is', null)
      .gte('owner_assigned_at', since.toISOString());
    /*
      This error was DISCARDED — the destructure did not even name it.

      `assignedToday` is what stops somebody being given more than their daily
      quota. A failed read leaves `load` empty, so every person reads as having
      taken nothing today and the allocator happily fills all 25 slots again. The
      failure direction is over-assignment, which spends Apollo credits and puts
      duplicate work in front of a person, so it cannot be silent.
    */
    if (loadError) {
      return { users: [], unavailable: `today's assignment counts could not be read: ${loadError.message}` };
    }

    const load = new Map<string, number>();
    for (const r of (todays ?? []) as { assignee_id: string }[]) {
      load.set(r.assignee_id, (load.get(r.assignee_id) ?? 0) + 1);
    }

    const users = ((profiles ?? []) as Record<string, unknown>[]).map((p) => ({
      id: p.id as string,
      name: (p.name as string) ?? 'Unnamed',
      userId: (p.user_id as string) ?? null,
      role: (p.role as string) ?? 'bdr',
      bu: (p.bu as string[]) ?? [],
      verticals: (p.verticals as string[]) ?? [],
      regions: (p.regions as string[]) ?? [],
      dailyQuota: (p.daily_lead_quota as number) ?? 50,
      preferredVerticals: (p.preferred_verticals as string[]) ?? [],
      assignedToday: load.get(p.id as string) ?? 0,
      isActive: Boolean(p.is_active),
    }));
    return { users, unavailable: null };
  } catch (err) {
    return { users: [], unavailable: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Moves a lead to a new owner, appending to the history.
 *
 * `slaHours` stamps the deadline at assignment time, so later policy changes
 * never retroactively breach leads already in flight.
 */
export async function reassignLead(
  leadId: string,
  toUserId: string | null,
  options: { reason?: string; ruleId?: string; changedBy?: string; slaHours?: number } = {}
): Promise<{ ok: boolean; message: string }> {
  if (!isSupabaseServiceConfigured()) return { ok: false, message: 'Supabase service role is not configured.' };

  try {
    const service = getServiceSupabase();
    const { data: current } = await service
      .from('canonical_projects')
      .select('owner_user_id')
      .eq('id', leadId)
      .maybeSingle();

    const fromUserId = (current as { owner_user_id: string | null } | null)?.owner_user_id ?? null;
    if (fromUserId === toUserId) return { ok: true, message: 'Already assigned to that owner.' };

    // `toUserId` is a ROSTER id. `assignee_id` takes it; `owner_user_id` is a
    // foreign key to user_profiles and takes the app account that roster entry is
    // linked to — null for the majority of the roster, who never sign in.
    //
    // Writing the roster id straight into owner_user_id violated that key, so
    // manually assigning to anyone without an account failed outright with a
    // constraint error. `applyAssignments` has always mapped it; this did not.
    let ownerAccountId: string | null = null;
    if (toUserId) {
      const { data: assignee } = await service.from('assignees').select('user_id').eq('id', toUserId).maybeSingle();
      ownerAccountId = (assignee as { user_id: string | null } | null)?.user_id ?? null;
    }

    const now = new Date();
    const patch: Record<string, unknown> = {
      assignee_id: toUserId,
      owner_user_id: ownerAccountId,
      owner_assigned_at: toUserId ? now.toISOString() : null,
      owner_assigned_reason: options.reason ?? null,
      sla_due_at:
        toUserId && options.slaHours ? new Date(now.getTime() + options.slaHours * 3_600_000).toISOString() : null,
      sla_breached: false,
    };

    const { error } = await service.from('canonical_projects').update(patch).eq('id', leadId);
    if (error) {
      const hint = /schema cache|does not exist/i.test(error.message) ? ' Run the assignment migration first.' : '';
      return { ok: false, message: `${error.message}.${hint}` };
    }

    await service.from('assignment_history').insert({
      lead_id: leadId,
      from_user_id: fromUserId,
      to_user_id: toUserId,
      rule_id: options.ruleId ?? null,
      reason: options.reason ?? null,
      changed_by: options.changedBy ?? null,
    });

    return { ok: true, message: toUserId ? 'Lead reassigned.' : 'Lead unassigned.' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Bulk owner write for the auto-assign pass. History is written per lead. */
export async function applyAssignments(
  assignments: { leadId: string; userId: string; ruleId: string }[],
  slaHoursByLead: Map<string, number> = new Map()
): Promise<number> {
  if (!isSupabaseServiceConfigured() || assignments.length === 0) return 0;

  const service = getServiceSupabase();
  // `userId` on an assignment is a ROSTER id. Only some of those people have
  // an app account, and owner_user_id is what "My Leads" and the RLS policies
  // read — so it is kept in step for the ones who do, and left null for the
  // rest rather than pointing at a user that does not exist.
  const accountByAssignee = new Map<string, string | null>();
  try {
    const { data } = await service.from('assignees').select('id, user_id');
    for (const r of (data ?? []) as { id: string; user_id: string | null }[]) {
      accountByAssignee.set(r.id, r.user_id);
    }
  } catch {
    // No roster table yet — assignments still record who owns the lead.
  }
  const now = new Date();
  let applied = 0;

  for (const a of assignments) {
    const slaHours = slaHoursByLead.get(a.leadId);
    const { error } = await service
      .from('canonical_projects')
      .update({
        assignee_id: a.userId,
        owner_user_id: accountByAssignee.get(a.userId) ?? null,
        owner_assigned_at: now.toISOString(),
        owner_assigned_reason: a.ruleId,
        sla_due_at: slaHours ? new Date(now.getTime() + slaHours * 3_600_000).toISOString() : null,
      })
      // Only claim leads that are still unowned — a concurrent pass or a
      // manual assignment must win over this one, not be overwritten.
      .eq('id', a.leadId)
      // Unowned means no ASSIGNEE. owner_user_id is null for everyone on the
      // roster without an app account, so checking it would treat their leads
      // as free and reassign them on every run.
      .is('assignee_id', null);

    if (!error) applied += 1;
  }

  if (applied > 0) {
    await service.from('assignment_history').insert(
      assignments.map((a) => ({
        lead_id: a.leadId,
        from_user_id: null,
        to_user_id: a.userId,
        rule_id: a.ruleId,
        reason: 'Auto-assigned',
      }))
    );
  }

  return applied;
}


/**
 * The lead-mix policy. Falls back to the built-in default — strict priority
 * order, no shares — so assignment behaves exactly as it did until somebody
 * declares a mix.
 */
export async function getAllocationPolicy(): Promise<{ policy: AllocationPolicy; isDefault: boolean }> {
  try {
    const { data, error } = await configReader()
      .from('allocation_policy')
      .select('config')
      .eq('id', 'default')
      .maybeSingle();
    if (error || !data?.config || Object.keys(data.config as object).length === 0) {
      return { policy: DEFAULT_ALLOCATION, isDefault: true };
    }
    return { policy: mergeAllocationPolicy(data.config), isDefault: false };
  } catch {
    return { policy: DEFAULT_ALLOCATION, isDefault: true };
  }
}

export async function saveAllocationPolicy(input: unknown): Promise<{ ok: boolean; message: string }> {
  if (!isSupabaseServiceConfigured()) {
    return { ok: false, message: 'Supabase service role is not configured.' };
  }
  const v = validateAllocationPolicy(input);
  if (!v.ok) return { ok: false, message: v.error };

  const { error } = await getServiceSupabase()
    .from('allocation_policy')
    .upsert({ id: 'default', config: v.policy }, { onConflict: 'id' });
  if (error) {
    const hint = /schema cache|does not exist/i.test(error.message) ? ' Run the allocation_policy migration first.' : '';
    return { ok: false, message: `${error.message}.${hint}` };
  }
  return { ok: true, message: describeAllocation(v.policy) };
}

/** A person's daily quota and soft vertical preference. */
export async function saveUserAllocation(
  userId: string,
  patch: { dailyQuota?: number; preferredVerticals?: string[] }
): Promise<{ ok: boolean; message: string }> {
  if (!isSupabaseServiceConfigured()) {
    return { ok: false, message: 'Supabase service role is not configured.' };
  }
  const row: Record<string, unknown> = {};
  if (patch.dailyQuota !== undefined) row.daily_lead_quota = Math.max(0, Math.min(1000, Math.round(patch.dailyQuota)));
  if (patch.preferredVerticals !== undefined) row.preferred_verticals = patch.preferredVerticals;
  if (Object.keys(row).length === 0) return { ok: true, message: 'Nothing to change.' };

  const { error } = await getServiceSupabase().from('user_profiles').update(row).eq('id', userId);
  if (error) {
    const hint = /preferred_verticals/.test(error.message) ? ' Run the allocation_policy migration first.' : '';
    return { ok: false, message: `${error.message}.${hint}` };
  }
  return { ok: true, message: 'Saved.' };
}


/** Everyone on the roster, active or not — what the Team page manages. */
export async function getRoster(): Promise<{ rows: Assignee[]; tableMissing: boolean }> {
  try {
    const { data, error } = await configReader()
      .from('assignees')
      .select('*')
      .order('is_active', { ascending: false })
      .order('name');
    if (error) {
      return { rows: [], tableMissing: /does not exist|schema cache/i.test(error.message) };
    }
    return { rows: (data ?? []) as unknown as Assignee[], tableMissing: false };
  } catch {
    return { rows: [], tableMissing: true };
  }
}

export interface Assignee {
  id: string;
  name: string;
  email: string | null;
  role: string;
  bu: string[];
  verticals: string[];
  regions: string[];
  preferred_verticals: string[];
  daily_lead_quota: number;
  is_active: boolean;
  user_id: string | null;
}

/** Add or update someone on the roster. No invitation, no account required. */
export async function saveAssignee(
  patch: Partial<Assignee> & { id?: string }
): Promise<{ ok: boolean; message: string }> {
  if (!isSupabaseServiceConfigured()) {
    return { ok: false, message: 'Supabase service role is not configured.' };
  }
  if (!patch.id && !patch.name?.trim()) {
    return { ok: false, message: 'A name is required.' };
  }

  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.email !== undefined) row.email = patch.email?.trim() || null;
  if (patch.role !== undefined) row.role = patch.role;
  if (patch.bu !== undefined) row.bu = patch.bu;
  if (patch.verticals !== undefined) row.verticals = patch.verticals;
  if (patch.regions !== undefined) row.regions = patch.regions;
  if (patch.preferred_verticals !== undefined) row.preferred_verticals = patch.preferred_verticals;
  if (patch.daily_lead_quota !== undefined) {
    row.daily_lead_quota = Math.max(0, Math.min(1000, Math.round(patch.daily_lead_quota)));
  }
  if (patch.is_active !== undefined) row.is_active = patch.is_active;

  const service = getServiceSupabase();

  // An address already on the roster updates that person rather than adding a
  // second of them. Without this, pressing Add twice — or a save that appeared
  // to fail because the list was not refreshing — silently creates duplicates,
  // and a duplicate is not cosmetic: assignment treats them as two people with
  // two separate daily quotas.
  let targetId = patch.id;
  if (!targetId && typeof row.email === 'string' && row.email) {
    const { data: existing } = await service
      .from('assignees')
      .select('id')
      .ilike('email', row.email)
      .maybeSingle();
    targetId = (existing as { id: string } | null)?.id;
  }

  const { error } = targetId
    ? await service.from('assignees').update(row).eq('id', targetId)
    : await service.from('assignees').insert(row);

  if (error) {
    const hint = /does not exist|schema cache/i.test(error.message) ? ' Run the assignees migration first.' : '';
    return { ok: false, message: `${error.message}.${hint}` };
  }
  return {
    ok: true,
    message: patch.id
      ? 'Saved.'
      : targetId
        ? `${row.name} was already on the roster — updated instead of added.`
        : `${row.name} can now receive leads.`,
  };
}

/** Remove someone. Their leads return to the pool rather than vanishing. */
export async function removeAssignee(id: string): Promise<{ ok: boolean; message: string }> {
  if (!isSupabaseServiceConfigured()) {
    return { ok: false, message: 'Supabase service role is not configured.' };
  }
  const service = getServiceSupabase();

  // Removing someone is what orphans a rule: the rule keeps their id, matches
  // nobody, and reports successful runs that assign nothing. Disable those rules
  // in the same breath and say which — leaving them enabled is how a rule ends
  // up pointing at an id that exists nowhere, and disabling rather than deleting
  // keeps the intent so it can be re-pointed at a colleague.
  let disabled: string[] = [];
  try {
    const { rules } = await getAssignmentRules();
    const affected = rules.filter((r) => r.toUserId === id && r.enabled !== false);
    if (affected.length > 0) {
      disabled = affected.map((r) => r.name);
      const next = rules.map((r) => (r.toUserId === id ? { ...r, enabled: false } : r));
      await service.from('assignment_rules').upsert({ id: 'default', rules: next }, { onConflict: 'id' });
    }
  } catch {
    // No rules table yet, or unreadable — removal itself still stands.
  }

  const { error } = await service.from('assignees').delete().eq('id', id);
  if (error) return { ok: false, message: error.message };

  const note = disabled.length
    ? ` ${disabled.length} rule${disabled.length === 1 ? '' : 's'} pointed at them and ${disabled.length === 1 ? 'was' : 'were'} disabled: ${disabled.map((n) => `“${n}”`).join(', ')}.`
    : '';
  return { ok: true, message: `Removed — their leads are back in the pool.${note}` };
}
