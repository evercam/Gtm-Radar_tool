import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { checkPermission, type SessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { transitionLead } from '@/lib/lifecycleStore';
import {
  reassignLead,
  getAssignmentRules,
  getAssignableUsers,
  applyAssignments,
  getAllocationPolicy,
} from '@/lib/assignmentStore';
import type { AssignableLead } from '@/lib/assignment';
import { planAllocation } from '@/lib/allocation';
import { isColdArrival } from '@/lib/arrival';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/leads — the actions a seller takes on a lead they own.
 *
 * Ownership is checked per action rather than by role alone: a BDR may mark
 * their own lead contacted, but not someone else's. Managers and admins hold
 * `leads.view.all` and can act on any lead.
 */

/** Whether this user may act on this specific lead. */
async function ownsOrManages(user: SessionUser, leadId: string): Promise<boolean> {
  if (can(user, 'leads.view.all')) return true;
  try {
    const { data } = await getServiceSupabase()
      .from('canonical_projects')
      .select('owner_user_id')
      .eq('id', leadId)
      .maybeSingle();
    return (data as { owner_user_id: string | null } | null)?.owner_user_id === user.id;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  // checkPermission rather than getSessionUser: assignment runs on a schedule,
  // and a scheduler has no cookies. Without this the nightly assign step could
  // never authenticate, so leads would only ever be assigned by hand.
  const auth = await checkPermission('leads.view.own');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });
  const user = auth.user;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: false, message: 'Supabase service key not configured.' }, { status: 200 });
  }

  let body: {
    action?: string;
    id?: string;
    toUserId?: string;
    reason?: string;
    rules?: unknown;
    assignee?: Record<string, unknown>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON.' }, { status: 400 });
  }

  const service = getServiceSupabase();

  // --- rule management (admins) --------------------------------------------
  if (body.action === 'saveRules') {
    if (!can(user, 'settings.manage')) {
      return NextResponse.json({ ok: false, message: 'Your role does not allow this action.' }, { status: 403 });
    }
    const { saveAssignmentRules } = await import('@/lib/assignmentStore');
    return NextResponse.json(await saveAssignmentRules(body.rules), { status: 200 });
  }

  // --- the roster: who can receive leads, no invitation required -----------
  if (body.action === 'saveAssignee' || body.action === 'removeAssignee') {
    if (!can(user, 'users.manage')) {
      return NextResponse.json({ ok: false, message: 'Your role does not allow this action.' }, { status: 403 });
    }
    const { saveAssignee, removeAssignee } = await import('@/lib/assignmentStore');
    if (body.action === 'removeAssignee') {
      if (!body.id) return NextResponse.json({ ok: false, message: 'An id is required.' }, { status: 400 });
      return NextResponse.json(await removeAssignee(body.id), { status: 200 });
    }
    return NextResponse.json(await saveAssignee(body.assignee ?? {}), { status: 200 });
  }

  // --- the auto-assign pass (managers and admins) ---------------------------
  if (body.action === 'autoAssign') {
    if (!can(user, 'leads.reassign')) {
      return NextResponse.json({ ok: false, message: 'Your role does not allow this action.' }, { status: 403 });
    }

    const [{ rules }, { users, unavailable: rosterUnavailable }, { policy }] = await Promise.all([
      getAssignmentRules(),
      getAssignableUsers(),
      getAllocationPolicy(),
    ]);
    /*
      A failed roster read is not an empty roster.

      Both produce zero users, and the message below sends somebody to go and add
      people to a roster that is fine. Worse, the second read inside
      getAssignableUsers is today's assignment counts — if THAT failed, everyone
      would read as having taken nothing today and this pass would hand out full
      quotas on top of what was already assigned.
    */
    if (rosterUnavailable) {
      return NextResponse.json({
        ok: false,
        message: `Nothing was assigned — the roster could not be read (${rosterUnavailable}). This is a failed read, not an empty roster: retry rather than adding people.`,
      });
    }
    if (users.length === 0) {
      return NextResponse.json({ ok: false, message: 'No active users are available to receive leads.' });
    }

    // Only enriched-or-better, unowned leads are distributable: assigning a
    // raw record hands someone a lead with nothing to act on.
    const { data, error } = await service
      .from('canonical_projects')
      .select(
        'id, bu, vertical, country, icp_code, record_type, priority_band, priority_score, estimated_value, route, stage, contact_status, owner_user_id, assignee_id, source_key, current_phase, construction_start_date, estimated_completion_date, announced_date, bid_date'
      )
      // Unowned means no assignee — most of the roster has no app account,
      // so owner_user_id is null for their leads too.
      .is('assignee_id', null)
      .in('status', ['ENRICHED', 'PREPARED'])
      /*
        A lead nobody can be reached on is not distributable.

        Every authored rule carries `requiresContact: true`, but
        ROSTER_FALLBACK_RULE has empty conditions and therefore no contact
        requirement — and the fallback is what places almost everything. Measured
        on the live book: 184 of 185 assignments came from the fallback, and 60 of
        those leads have no email and no phone anywhere on them. They sat in
        somebody's name doing nothing, and the export then reported them as
        "nothing eligible".

        Filtered on the real columns rather than on `contact_status`, which
        disagrees with them in both directions here — 10 rows read `has_contact`
        with no channel at all, and 5 read `needs_enrichment` while carrying one.
        `additional_contacts` counts, because the committee is where the people
        usually are.
      */
      .or('contact_email.not.is.null,contact_phone.not.is.null,additional_contacts.neq.[]')
      /*
        A lead the brief called too late must not occupy somebody's quota.

        The export now refuses to send these, so assigning one spends a slot out of
        a 25/day allowance on a lead that can never leave the desk — it would look
        like a full day's work and produce nothing. Gating here as well as at the
        export keeps the two in agreement about what is worth a person's time.

        Nulls are kept: no timing means the brief has not run, not that the lead is
        late, and `neq` alone would drop them.
      */
      .or('evercam_timing.is.null,evercam_timing.neq.too_late')
      .order('priority_score', { ascending: false, nullsFirst: false })
      .limit(1000);

    if (error) {
      const hint = /does not exist|schema cache/i.test(error.message) ? ' Run the assignment migration first.' : '';
      return NextResponse.json({ ok: false, message: `${error.message}.${hint}` }, { status: 200 });
    }

    /*
      Cold arrivals are not distributable.

      The phase and date columns are selected purely so `arrivalFor` can judge this
      — the allocator itself does not read them. Filtered in memory rather than in
      the query because the verdict reads the admin-editable phase table, and a SQL
      copy of that list would drift from it.

      Assignment matters as much as the export here: a cold lead given to somebody
      spends a slot out of their 25/day on something the export will refuse to
      send, so it would read as a full day's work and produce nothing.
    */
    const beforeCold = (data ?? []).length;
    const warm = ((data ?? []) as unknown as Record<string, unknown>[]).filter((r) => !isColdArrival(r));
    const coldSkipped = beforeCold - warm.length;

    // The engine reads assigneeId; the row spells it assignee_id.
    const leads = (warm as unknown as (AssignableLead & { assignee_id: string | null })[]).map((l) => ({
      ...l,
      assigneeId: l.assignee_id,
    }));
    const result = planAllocation(leads, rules, users, policy);
    const applied = await applyAssignments(result.assignments);

    // Assigned leads move to ASSIGNED so the lifecycle reflects who holds them.
    for (const a of result.assignments.slice(0, applied)) {
      await transitionLead(a.leadId, 'ASSIGNED', { actor: user.id, reason: `Assigned by rule: ${a.ruleName}` });
    }

    return NextResponse.json({
      ok: true,
      coldSkipped,
      message:
        `Assigned ${applied} lead${applied === 1 ? '' : 's'}` +
        `${result.atCapacity ? `, ${result.atCapacity} held (owners at quota)` : ''}` +
        // Named separately: raising a quota fixes the first and does nothing for
        // the second, which needs somebody activated or re-scoped.
        `${result.noCoverage ? `, ${result.noCoverage} with no eligible owner (no active assignee covers their BU, vertical or region)` : ''}` +
        `${result.heldForMix ? `, ${result.heldForMix} held to keep the mix` : ''}` +
        `${result.unassigned ? `, ${result.unassigned} matched no rule` : ''}.`,
      assigned: applied,
      atCapacity: result.atCapacity,
      noCoverage: result.noCoverage,
      unassigned: result.unassigned,
      heldForMix: result.heldForMix,
      buckets: result.buckets,
      candidates: leads.length,
    });
  }

  // --- per-lead actions -----------------------------------------------------
  if (!body.id) return NextResponse.json({ ok: false, message: 'A lead id is required.' }, { status: 400 });

  const permitted = await ownsOrManages(user, body.id);
  if (!permitted) {
    return NextResponse.json({ ok: false, message: 'That lead is not assigned to you.' }, { status: 403 });
  }

  switch (body.action) {
    case 'transfer': {
      if (!body.toUserId) {
        return NextResponse.json({ ok: false, message: 'A destination user is required.' }, { status: 400 });
      }
      // Anyone may hand their own lead on; only managers may move someone
      // else's, which ownsOrManages has already established.
      const res = await reassignLead(body.id, body.toUserId, {
        reason: body.reason ?? 'Transferred',
        changedBy: user.id,
      });
      return NextResponse.json(res);
    }

    case 'unassign': {
      if (!can(user, 'leads.reassign')) {
        return NextResponse.json({ ok: false, message: 'Your role does not allow this action.' }, { status: 403 });
      }
      const res = await reassignLead(body.id, null, {
        reason: body.reason ?? 'Returned to the pool',
        changedBy: user.id,
      });
      return NextResponse.json(res);
    }

    default:
      return NextResponse.json({ ok: false, message: `Unknown action "${body.action}".` }, { status: 400 });
  }
}
