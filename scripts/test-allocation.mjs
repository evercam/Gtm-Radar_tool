/**
 * Lead allocation — against the REAL src/lib/allocation.ts.
 *
 * This decides WHICH leads each person gets, and gets it wrong silently: a
 * mis-set share does not error, it just quietly hands somebody a week of one
 * vertical. So the tests weight the ways a mix can betray its own promise —
 * a share that overruns, a bucket that starves everything else, capacity
 * counted against leads instead of people, and a policy that holds back every
 * lead because nothing was declared.
 *
 *   node --experimental-transform-types scripts/test-allocation.mjs
 */

import {
  planAllocation,
  mergeAllocationPolicy,
  validateAllocationPolicy,
  DEFAULT_ALLOCATION,
} from '../src/lib/allocation.ts';

let passed = 0;
let failed = 0;
const check = (n, c, d) => {
  if (c) {
    passed++;
    console.log(`  PASS ${n}`);
  } else {
    failed++;
    console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`);
  }
};
const group = (n) => console.log(`\n${n}`);

const rule = { id: 'all', name: 'Everything to BDRs', priority: 1, enabled: true, conditions: {}, toRole: 'bdr' };
const user = (over = {}) => ({
  id: 'u1', role: 'bdr', bu: [], verticals: [], regions: [],
  dailyQuota: 100, assignedToday: 0, isActive: true, preferredVerticals: [], ...over,
});
let n = 0;
const lead = (vertical, score = 50, over = {}) => ({
  id: `l${++n}`, bu: 'usa', vertical, country: 'United States', icp_code: 'tier1_gc', record_type: 'project',
  priority_band: 'P2', priority_score: score, estimated_value: null, route: 'sales', stage: 'qualify',
  contact_status: 'has_contact', owner_user_id: null, source_key: 'gem', ...over,
});
const many = (vertical, count, score = 50) => Array.from({ length: count }, () => lead(vertical, score));
const countBy = (as, leads, vertical) =>
  as.filter((a) => leads.find((l) => l.id === a.leadId)?.vertical === vertical).length;

group('Priority mode is unchanged — strongest first, quotas the only limit');
{
  const leads = [...many('coal', 10, 90), ...many('data_center', 10, 10)];
  const r = planAllocation(leads, [rule], [user({ dailyQuota: 10 })], DEFAULT_ALLOCATION);
  check('assigns up to the quota', r.assignments.length === 10, String(r.assignments.length));
  check('takes the strongest', countBy(r.assignments, leads, 'coal') === 10);
  check('nothing held for a mix that was not declared', r.heldForMix === 0);
}

group('Mix mode splits the day by the declared shares');
{
  const leads = [...many('coal', 100, 90), ...many('data_center', 100, 10)];
  const policy = { ...DEFAULT_ALLOCATION, mode: 'mix', shares: { data_center: 50, coal: 50 }, fillRemainder: false };
  const r = planAllocation(leads, [rule], [user({ dailyQuota: 20 })], policy);
  check('respects the quota', r.assignments.length === 20, String(r.assignments.length));
  check('coal gets half', countBy(r.assignments, leads, 'coal') === 10, String(countBy(r.assignments, leads, 'coal')));
  check('data centre gets half despite scoring lower', countBy(r.assignments, leads, 'data_center') === 10);
}

group('Shares are percentages of the day, not relative weights');
{
  const leads = [...many('coal', 100), ...many('solar', 100), ...many('wind', 100)];
  const run = (shares) =>
    planAllocation(leads, [rule], [user({ dailyQuota: 30 })], {
      ...DEFAULT_ALLOCATION, mode: 'mix', shares, fillRemainder: false,
    });

  const full = run({ coal: 40, solar: 30, wind: 30 });
  check('40/30/30 claims the whole day', full.assignments.length === 30, String(full.assignments.length));
  check('coal takes 40% of 30', countBy(full.assignments, leads, 'coal') === 12, String(countBy(full.assignments, leads, 'coal')));
  check('solar takes 30% of 30', countBy(full.assignments, leads, 'solar') === 9, String(countBy(full.assignments, leads, 'solar')));

  // 4/3/3 is a tenth of the day, NOT the same ratio scaled up — the rest is
  // left for buckets nobody named, which is the point of percentages.
  const tenth = run({ coal: 4, solar: 3, wind: 3 });
  check('4/3/3 claims a tenth, not the whole day', tenth.assignments.length < full.assignments.length, String(tenth.assignments.length));
  check('one vertical can be pinned without naming the others', run({ coal: 20 }).assignments.length > 0);
}

group('An undeclared bucket is not starved');
{
  const leads = [...many('coal', 50), ...many('solar', 50)];
  const policy = { ...DEFAULT_ALLOCATION, mode: 'mix', shares: { coal: 50 }, fillRemainder: false };
  const r = planAllocation(leads, [rule], [user({ dailyQuota: 20 })], policy);
  check('solar still gets a share of what coal left', countBy(r.assignments, leads, 'solar') > 0, String(countBy(r.assignments, leads, 'solar')));
  check('coal is capped at its declared half', countBy(r.assignments, leads, 'coal') === 10, String(countBy(r.assignments, leads, 'coal')));
}

group('fillRemainder decides whether capacity is left idle');
{
  const leads = many('coal', 100);
  const shares = { data_center: 100 };
  const strict = planAllocation(leads, [rule], [user({ dailyQuota: 10 })], {
    ...DEFAULT_ALLOCATION, mode: 'mix', shares, fillRemainder: false,
  });
  check('strict leaves people idle rather than break the mix', strict.assignments.length === 0, String(strict.assignments.length));
  check('and reports what it held', strict.heldForMix === 100, String(strict.heldForMix));

  const relaxed = planAllocation(leads, [rule], [user({ dailyQuota: 10 })], {
    ...DEFAULT_ALLOCATION, mode: 'mix', shares, fillRemainder: true,
  });
  check('relaxed uses the capacity', relaxed.assignments.length === 10, String(relaxed.assignments.length));
}

group('Quotas still bind, and a share is a share of CAPACITY not of leads');
{
  const leads = many('coal', 1000);
  const r = planAllocation(leads, [rule], [user({ dailyQuota: 5 })], {
    ...DEFAULT_ALLOCATION, mode: 'mix', shares: { coal: 100 },
  });
  check('never exceeds the quota', r.assignments.length === 5, String(r.assignments.length));
  const withLoad = planAllocation(leads, [rule], [user({ dailyQuota: 5, assignedToday: 3 })], DEFAULT_ALLOCATION);
  check('the load already carried today counts against the quota', withLoad.assignments.length === 2, String(withLoad.assignments.length));
}

group('The global daily cap overrides everything');
{
  const leads = many('coal', 500);
  const r = planAllocation(leads, [rule], [user({ dailyQuota: 200 }), user({ id: 'u2', dailyQuota: 200 })], {
    ...DEFAULT_ALLOCATION, dailyCap: 7,
  });
  check('caps the run', r.assignments.length === 7, String(r.assignments.length));
}

group('Work spreads, and a preference only breaks ties');
{
  const leads = many('solar', 10);
  const r = planAllocation(leads, [rule], [user({ id: 'a', dailyQuota: 10 }), user({ id: 'b', dailyQuota: 10 })], DEFAULT_ALLOCATION);
  const a = r.assignments.filter((x) => x.userId === 'a').length;
  check('split evenly between two equals', a === 5, `a got ${a}`);

  const pref = planAllocation(
    leads, [rule],
    [user({ id: 'a', dailyQuota: 10 }), user({ id: 'b', dailyQuota: 10, preferredVerticals: ['solar'] })],
    DEFAULT_ALLOCATION
  );
  const bPref = pref.assignments.filter((x) => x.userId === 'b').length;
  check('the person who prefers solar gets more of it', bPref > 5, `b got ${bPref}`);
  check('but never more than their quota', bPref <= 10);
}

group('Nobody to assign to, nothing to assign');
{
  check('no users assigns nothing', planAllocation(many('coal', 10), [rule], [], DEFAULT_ALLOCATION).assignments.length === 0);
  check('no leads assigns nothing', planAllocation([], [rule], [user()], DEFAULT_ALLOCATION).assignments.length === 0);
  check('an inactive user receives nothing', planAllocation(many('coal', 5), [rule], [user({ isActive: false })], DEFAULT_ALLOCATION).assignments.length === 0);
  const noRule = planAllocation(many('coal', 5), [], [user()], DEFAULT_ALLOCATION);
  check('no rules means everything is unassigned', noRule.unassigned === 5 && noRule.assignments.length === 0);
  const owned = planAllocation(many('coal', 5).map((l) => ({ ...l, owner_user_id: 'someone' })), [rule], [user()], DEFAULT_ALLOCATION);
  check('an already-owned lead is left alone', owned.assignments.length === 0);
}

group('Scope is a hard filter, preference is not');
{
  const leads = [lead('coal'), lead('solar')];
  const scoped = planAllocation(leads, [rule], [user({ verticals: ['solar'] })], DEFAULT_ALLOCATION);
  check('a lead outside scope is never assigned', scoped.assignments.length === 1);
  check('and is reported as having no owner', scoped.atCapacity === 1, String(scoped.atCapacity));
}

group('The report reconciles with what happened');
{
  const leads = [...many('coal', 30), ...many('solar', 30)];
  const r = planAllocation(leads, [rule], [user({ dailyQuota: 20 })], {
    ...DEFAULT_ALLOCATION, mode: 'mix', shares: { coal: 50, solar: 50 }, fillRemainder: false,
  });
  const assignedInBuckets = r.buckets.reduce((s, b) => s + b.assigned, 0);
  check('bucket counts sum to the assignments', assignedInBuckets === r.assignments.length, `${assignedInBuckets} vs ${r.assignments.length}`);
  check('availability reflects the pool', r.buckets.find((b) => b.bucket === 'coal').available === 30);
  check('target shares are fractions', r.buckets.every((b) => b.targetShare >= 0 && b.targetShare <= 1));
}

group('Validation refuses a policy that cannot work');
check('shares over 100% rejected', validateAllocationPolicy({ mode: 'mix', shares: { a: 60, b: 60 } }).ok === false);
check('mix with no shares rejected', validateAllocationPolicy({ mode: 'mix', shares: {} }).ok === false);
check('mix with no shares key rejected', validateAllocationPolicy({ mode: 'mix' }).ok === false);
check('a negative share rejected', validateAllocationPolicy({ mode: 'mix', shares: { a: -5 } }).ok === false);
check('a zero daily cap rejected', validateAllocationPolicy({ mode: 'priority', dailyCap: 0 }).ok === false);
check('exactly 100% accepted', validateAllocationPolicy({ mode: 'mix', shares: { a: 60, b: 40 } }).ok === true);
check('priority mode needs no shares', validateAllocationPolicy({ mode: 'priority' }).ok === true);
check('a non-object rejected', validateAllocationPolicy([]).ok === false);

group('Merge never widens what was saved');
check('an unknown mode falls back to priority', mergeAllocationPolicy({ mode: 'nonsense' }).mode === 'priority');
check('an unknown dimension falls back to vertical', mergeAllocationPolicy({ dimension: 'colour' }).dimension === 'vertical');
check('a negative share is dropped', Object.keys(mergeAllocationPolicy({ shares: { a: -1 } }).shares).length === 0);
check('a non-numeric share is dropped', Object.keys(mergeAllocationPolicy({ shares: { a: 'lots' } }).shares).length === 0);
check('NaN daily cap becomes no cap', mergeAllocationPolicy({ dailyCap: NaN }).dailyCap === null);
check('a zero daily cap becomes no cap', mergeAllocationPolicy({ dailyCap: 0 }).dailyCap === null);
check('the defaults survive a merge', JSON.stringify(mergeAllocationPolicy(DEFAULT_ALLOCATION)) === JSON.stringify(DEFAULT_ALLOCATION));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
