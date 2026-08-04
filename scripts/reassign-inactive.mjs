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
 * The reassignment itself goes through `autoAssign`, the same pass the Team page
 * runs, so scope, quota, rules and the roster fallback all apply. This script only
 * releases the leads; it does not decide where they land.
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
const simUsers = active.map((r) => ({
  id: r.id,
  name: r.name,
  role: r.role,
  bu: r.bu ?? [],
  verticals: r.verticals ?? [],
  regions: r.regions ?? [],
  isActive: true,
  assignedToday: 0,
  dailyQuota: r.daily_lead_quota ?? 0,
}));
const sim = planAllocation(simLeads, rules, simUsers);
const placed = new Set(sim.assignments.map((a) => a.leadId));
const orphans = simLeads.filter((l) => !placed.has(l.id));

console.log(`\nforecast: ${sim.assignments.length} of ${stuck.length} would be placed`);
const simTally = {};
for (const a of sim.assignments) simTally[nameOf(a.userId)] = (simTally[nameOf(a.userId)] ?? 0) + 1;
for (const [who, n] of Object.entries(simTally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${who}`);

if (orphans.length) {
  console.log(`\n  ${orphans.length} would land NOWHERE — no active member's scope covers them:`);
  const byGap = {};
  for (const l of orphans) {
    const key = `bu=${l.bu ?? 'null'} vertical=${l.vertical ?? 'null'}`;
    byGap[key] = (byGap[key] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(byGap).sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(3)}  ${k}`);
  console.log('\n  Releasing those moves them from "assigned to somebody inactive" to');
  console.log('  "assigned to nobody" — visible in the unassigned pool, but still not worked.');
  console.log('  Widen a scope on Team & Users to close the gap, or accept the trade.');
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

const { autoAssign } = await import('@/lib/assignmentStore');
const result = await autoAssign({ dryRun: false });
console.log(`\nassignment pass: ${result.message ?? JSON.stringify(result)}`);

// Where they actually went, read back rather than assumed.
const { data: after } = await s.from('canonical_projects').select('assignee_id').in('id', ids);
const tally = {};
for (const r of after ?? []) tally[r.assignee_id ? nameOf(r.assignee_id) : 'STILL UNASSIGNED'] = (tally[r.assignee_id ? nameOf(r.assignee_id) : 'STILL UNASSIGNED'] ?? 0) + 1;
console.log('\nwhere the released leads landed:');
for (const [who, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${who}`);
