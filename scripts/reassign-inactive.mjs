/**
 * Moves unexported leads off inactive roster members.
 *
 *   # report only
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/reassign-inactive.mjs
 *
 *   # do it
 *   APPLY=1 node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/reassign-inactive.mjs
 *
 * A lead assigned to somebody inactive is stuck: the export skips them, so the
 * lead is neither worked nor available to anyone who could work it, and nothing
 * in the app said so until the handover table.
 *
 * ALREADY-EXPORTED leads are left exactly as they are. Their assignee is history
 * — who the handover went to — and rewriting it would falsify the record of what
 * was sent and to whom.
 *
 * The reassignment goes through planAllocation and applyAssignments — the same
 * engine the Team page runs — so scope, quota, rules and the roster fallback all
 * apply. This script only releases the leads; it does not decide where they land.
 */

import { getServiceSupabase } from '@/lib/supabase/server';
import { getRoster } from '@/lib/assignmentStore';

const apply = process.env.APPLY === '1';
const s = getServiceSupabase();

const { rows: roster } = await getRoster();
const inactive = roster.filter((r) => !r.is_active);
const active = roster.filter((r) => r.is_active);
const nameOf = (id) => roster.find((r) => r.id === id)?.name ?? `unrostered:${String(id).slice(0, 8)}`;

console.log(`roster: ${active.length} active, ${inactive.length} inactive`);
console.log(`  active: ${active.map((r) => `${r.name} (quota ${r.daily_lead_quota ?? 0})`).join(', ') || 'NOBODY'}`);
if (active.length === 0) {
  console.error('\nNobody is active. Releasing leads now would leave them unowned — refusing.');
  process.exit(1);
}
// Someone active but on a zero quota cannot receive either, so the pass would
// release leads it then cannot place.
const withQuota = active.filter((r) => (r.daily_lead_quota ?? 0) > 0);
if (withQuota.length === 0) {
  console.error('\nEvery active member is on a zero quota — nothing could be placed. Refusing.');
  process.exit(1);
}

const inactiveIds = inactive.map((r) => r.id);
if (inactiveIds.length === 0) {
  console.log('\nNo inactive members hold anything. Nothing to do.');
  process.exit(0);
}

const { data: held, error } = await s
  .from('canonical_projects')
  .select('id, canonical_name, assignee_id, apollo_exported_at, contact_email, status')
  .in('assignee_id', inactiveIds);
if (error) {
  console.error('query failed:', error.message);
  process.exit(1);
}

const exported = (held ?? []).filter((r) => r.apollo_exported_at);
const stuck = (held ?? []).filter((r) => !r.apollo_exported_at);

console.log(`\n${held.length} lead(s) held by inactive members:`);
console.log(`  ${exported.length} already exported — LEFT ALONE (their assignee is the handover record)`);
console.log(`  ${stuck.length} unexported — these are the stuck ones`);

const byPerson = {};
for (const r of stuck) (byPerson[nameOf(r.assignee_id)] ??= []).push(r);
for (const [who, list] of Object.entries(byPerson)) {
  console.log(`\n  from ${who} (${list.length}):`);
  for (const r of list.slice(0, 6)) console.log(`     ${r.canonical_name.slice(0, 58)}${r.contact_email ? '  [has email]' : ''}`);
  if (list.length > 6) console.log(`     … and ${list.length - 6} more`);
}

if (stuck.length === 0) process.exit(0);

/*
  Where would they actually land?

  Releasing a lead that nobody can then receive turns "assigned to someone
  inactive" into "assigned to nobody", which is not a fix. Every active member is
  scoped to bu=usa and to a list of verticals, so a lead outside those lands
  nowhere — and that has to be known BEFORE the release, not discovered after.

  Simulated with the real engine on the real rules, so this is a forecast rather
  than a guess.
*/
const { planAllocation } = await import('@/lib/allocation');
const { getAssignmentRules } = await import('@/lib/assignmentStore');
const { rules } = await getAssignmentRules();

const { data: detail } = await s
  .from('canonical_projects')
  .select('id, bu, vertical, country, icp_code, record_type, priority_band, priority_score, route, stage, estimated_value, contact_status')
  .in('id', stuck.map((r) => r.id));

const simLeads = (detail ?? []).map((r) => ({ ...r, assigneeId: null, owner_user_id: null }));
/*
  The engine's own view of the roster, which carries `assignedToday`.

  Building this by hand with `assignedToday: 0` forecast a fresh day rather than
  right now. Against a roster whose quotas were already spent it predicted 18
  placements and the real pass placed none — quota is per-day, so a forecast that
  ignores today's usage is not a forecast.
*/
const { getAssignableUsers } = await import('@/lib/assignmentStore');
const simUsers = await getAssignableUsers();
for (const u of simUsers) console.log(`  capacity now: ${String(u.name ?? u.id).padEnd(16)} ${u.dailyQuota - u.assignedToday} of ${u.dailyQuota} free`);
const sim = planAllocation(simLeads, rules, simUsers);
const placed = new Set(sim.assignments.map((a) => a.leadId));
const orphans = simLeads.filter((l) => !placed.has(l.id));

console.log(`\nforecast: ${sim.assignments.length} of ${stuck.length} would be placed`);
const simTally = {};
for (const a of sim.assignments) simTally[nameOf(a.userId)] = (simTally[nameOf(a.userId)] ?? 0) + 1;
for (const [who, n] of Object.entries(simTally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${who}`);

if (orphans.length) {
  /*
    Two very different reasons, and reporting them as one is misleading.

    NO SCOPE means nobody's patch covers the lead — it will never place until
    somebody's verticals or BU are widened. OUT OF CAPACITY means somebody does
    cover it and is simply full today; it places itself on the next run, with no
    configuration change at all.

    Said as one line ("no active member's scope covers them") this sent me looking
    for a coverage gap that had already been closed.
  */
  const { userCoversLead } = await import('@/lib/assignment');
  const noScope = orphans.filter((l) => !simUsers.some((u) => userCoversLead(u, l)));
  const noRoom = orphans.filter((l) => simUsers.some((u) => userCoversLead(u, l)));

  if (noScope.length) {
    console.log(`\n  ${noScope.length} cannot be placed AT ALL — no active member's scope covers them:`);
    const byGap = {};
    for (const l of noScope) {
      const key = `bu=${l.bu ?? 'null'} vertical=${l.vertical ?? 'null'}`;
      byGap[key] = (byGap[key] ?? 0) + 1;
    }
    for (const [k, n] of Object.entries(byGap).sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(3)}  ${k}`);
    console.log('  Widen a scope on Team & Users, or these stay where they are.');
  }
  if (noRoom.length) {
    console.log(`\n  ${noRoom.length} are covered but everyone who covers them is at quota today.`);
    console.log('  Nothing to configure — they place themselves on the next run, or raise a quota.');
  }
}

if (!apply) {
  console.log(`\n${stuck.length} lead(s) would be released and re-run through assignment. Re-run with APPLY=1.`);
  process.exit(0);
}

/*
  Only the leads the forecast can place are released.

  Releasing one that nobody covers would move it from "assigned to somebody
  inactive" to "assigned to nobody" — more visible, but no closer to being
  worked, and it would discard the record of who was holding it for no gain. Those
  stay put until a scope covers them, and are named above so the gap is actionable
  rather than silently absorbed.
*/
const ids = simLeads.filter((l) => placed.has(l.id)).map((l) => l.id);
if (ids.length === 0) {
  console.log('\nNothing is placeable right now — releasing nothing. Widen a scope first.');
  process.exit(0);
}
console.log(`\nreleasing ${ids.length} of ${stuck.length} (the placeable ones); leaving ${orphans.length} where they are`);
let released = 0;
for (let i = 0; i < ids.length; i += 200) {
  const slice = ids.slice(i, i + 200);
  const { error: relErr } = await s
    .from('canonical_projects')
    .update({ assignee_id: null, owner_user_id: null, owner_assigned_at: null, owner_assigned_reason: null })
    .in('id', slice);
  if (relErr) {
    console.error('release failed:', relErr.message);
    process.exit(1);
  }
  released += slice.length;
}
console.log(`\nreleased ${released}`);

/*
  Placed with planAllocation + applyAssignments, mirroring /api/leads.

  That endpoint cannot be reused: it only considers leads whose status is ENRICHED
  or PREPARED, and a released lead still reads ASSIGNED — so it would skip every
  one of them and report success having done nothing.
*/
const { applyAssignments } = await import('@/lib/assignmentStore');
const freshUsers = await getAssignableUsers();
const { data: releasedRows } = await s
  .from('canonical_projects')
  .select('id, bu, vertical, country, icp_code, record_type, priority_band, priority_score, estimated_value, route, stage, contact_status, owner_user_id, assignee_id')
  .in('id', ids);
const plan = planAllocation(
  (releasedRows ?? []).map((l) => ({ ...l, assigneeId: l.assignee_id })),
  rules,
  freshUsers
);
const applied = await applyAssignments(plan.assignments);
console.log(`placed ${applied} of ${ids.length} (atCapacity=${plan.atCapacity}, unassigned=${plan.unassigned})`);

/*
  Nothing may be left as ASSIGNED-with-no-assignee.

  That state is invisible to the export AND to the unassigned pool, so a lead in
  it is worked by nobody and listed nowhere. It is the exact inconsistency an
  earlier run of this script created, so anything unplaced is put back to the
  stage it had genuinely reached.
*/
const stranded = ids.filter((id) => !plan.assignments.some((a) => a.leadId === id));
if (stranded.length) {
  console.log(`  ${stranded.length} unplaced — restoring them to an owner-less stage`);
  const { data: st } = await s
    .from('canonical_projects')
    .select('id, prepared_at, call_prep_generated_at, enriched_at')
    .in('id', stranded);
  for (const r of st ?? []) {
    const status = r.prepared_at || r.call_prep_generated_at ? 'PREPARED' : r.enriched_at ? 'ENRICHED' : null;
    if (!status) continue;
    await s
      .from('canonical_projects')
      .update({ status, owner_assigned_at: null, owner_assigned_reason: null, sla_due_at: null, sla_breached: false })
      .eq('id', r.id);
  }
}

// Where they actually went, read back rather than assumed.
const { data: after } = await s.from('canonical_projects').select('assignee_id').in('id', ids);
const tally = {};
for (const r of after ?? []) tally[r.assignee_id ? nameOf(r.assignee_id) : 'STILL UNASSIGNED'] = (tally[r.assignee_id ? nameOf(r.assignee_id) : 'STILL UNASSIGNED'] ?? 0) + 1;
console.log('\nwhere the released leads landed:');
for (const [who, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${who}`);
