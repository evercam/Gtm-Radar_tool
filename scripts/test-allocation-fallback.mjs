/**
 * The roster fallback — against the REAL engine.
 *
 * Focused on one behaviour: a lead that no authored rule claims still reaches
 * somebody. `test-allocation.mjs` covers the mix/share policy against the same
 * live `planAllocation`; this covers the fallback path and the guards that must
 * survive it — scope, quota, and an authored rule keeping precedence.
 *
 * (Note for anyone extending coverage: `scripts/test-assignment.mjs` carries its
 * own copy of the distribution logic and exercises `assignLeads`, which has no
 * callers. Neither of those touches the code path `/api/leads` runs.)
 *
 *   node --experimental-transform-types --import ./scripts/lib/register-alias.mjs \
 *     scripts/test-allocation-fallback.mjs
 */

const { planAllocation, ROSTER_FALLBACK_RULE } = await import('../src/lib/allocation.ts');

let passed = 0;
let failed = 0;
const t = (name, cond, detail) => {
  if (cond) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

const user = (over = {}) => ({
  id: 'u1',
  name: 'One',
  role: 'bdr',
  bu: [],
  verticals: [],
  regions: [],
  dailyQuota: 10,
  assignedToday: 0,
  isActive: true,
  ...over,
});

const lead = (over = {}) => ({
  id: 'l1',
  bu: 'usa',
  vertical: 'solar',
  country: 'United States',
  priority_band: 'P2',
  priority_score: 60,
  estimated_value: null,
  route: 'sales',
  stage: 'act_now',
  contact_status: 'has_contact',
  owner_user_id: null,
  assigneeId: null,
  ...over,
});

console.log('\nNo rules at all');
{
  const r = planAllocation([lead()], [], [user()]);
  t('a lead is still assigned', r.assignments.length === 1, JSON.stringify(r));
  t('nothing is reported as unmatched', r.unassigned === 0, `unassigned=${r.unassigned}`);
  t('credited to the fallback rule', r.assignments[0]?.ruleId === ROSTER_FALLBACK_RULE.id, r.assignments[0]?.ruleId);
}

console.log('\nAn authored rule still wins');
{
  const rules = [
    { id: 'to_two', name: 'To the second', priority: 1, enabled: true, conditions: {}, toUserId: 'u2', toRole: null },
  ];
  const r = planAllocation([lead()], rules, [user(), user({ id: 'u2' })]);
  t('the authored rule takes the lead', r.assignments[0]?.userId === 'u2', JSON.stringify(r.assignments));
  t('not the fallback', r.assignments[0]?.ruleId === 'to_two');
}

console.log('\nScope still binds');
{
  // The only person on the roster covers a different BU entirely.
  const r = planAllocation([lead({ bu: 'usa' })], [], [user({ bu: ['uk'] })]);
  t('a lead outside every scope is not forced on anyone', r.assignments.length === 0);
  t('it is held, not silently dropped', r.atCapacity === 1, `atCapacity=${r.atCapacity}`);
}

console.log('\nQuota still binds');
{
  const leads = [lead({ id: 'a' }), lead({ id: 'b' }), lead({ id: 'c' })];
  const r = planAllocation(leads, [], [user({ dailyQuota: 2 })]);
  t('never exceeds the daily quota', r.assignments.length === 2, `${r.assignments.length} assigned`);
  t('the overflow is reported', r.atCapacity === 1, `atCapacity=${r.atCapacity}`);
}

console.log('\nAn inactive roster means nothing flows');
{
  const r = planAllocation([lead()], [], [user({ isActive: false })]);
  t('an inactive person receives nothing', r.assignments.length === 0);
}

console.log('\nWork spreads rather than piling on one person');
{
  const leads = Array.from({ length: 6 }, (_, i) => lead({ id: `l${i}` }));
  const r = planAllocation(leads, [], [user({ id: 'a' }), user({ id: 'b' })]);
  const perUser = new Map();
  for (const a of r.assignments) perUser.set(a.userId, (perUser.get(a.userId) ?? 0) + 1);
  t('all six placed', r.assignments.length === 6, `${r.assignments.length}`);
  t('split evenly by remaining headroom', [...perUser.values()].every((n) => n === 3), JSON.stringify([...perUser]));
}

console.log('\nA rule naming no recipient means "anyone who covers it"');
{
  const rules = [
    { id: 'solar_any', name: 'Solar to anyone', priority: 1, enabled: true, conditions: { vertical: ['solar'] }, toUserId: null, toRole: null },
  ];
  const r = planAllocation([lead({ vertical: 'solar' })], rules, [user()]);
  t('it assigns rather than resolving to nobody', r.assignments.length === 1);
  t('credited to that rule, not the fallback', r.assignments[0]?.ruleId === 'solar_any', r.assignments[0]?.ruleId);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
