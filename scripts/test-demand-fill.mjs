/**
 * Demand-driven filling — produce for the people who are short, not for the
 * highest score.
 *
 *   node --experimental-transform-types --import ./scripts/lib/register-alias.mjs \
 *        scripts/test-demand-fill.mjs
 *
 * `fillOrder` is pure, so this needs no database.
 *
 * The case that matters is a narrow scope against a wide one. A rep covering only
 * mining has a small ABSOLUTE deficit by definition — the roster gives them a
 * smaller quota and their pool is smaller — so any rule that serves "whoever is
 * furthest behind" never reaches them. The first version of fillOrder did exactly
 * that and handed all ten slots to the person with the largest number.
 */

import { fillOrder } from '../src/lib/enrich/demand.ts';

let passed = 0,
  failed = 0;
const check = (n, c, d) => {
  if (c) {
    passed++;
    console.log(`  PASS ${n}`);
  } else {
    failed++;
    console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`);
  }
};

/*
  Shaped like the real PersonDemand, including the three-day floor.

  Without `floor` and `urgentDeficit` these fixtures took the monthly-share path
  by accident — `undefined > 0` is false — so the floor logic would have gone
  untested while the suite stayed green.
*/
const MIN_DAYS = 3;
const person = (name, quota, deficit, scope = {}) => {
  const target = quota * 24;
  const covered = target - deficit;
  const floor = quota * MIN_DAYS;
  return {
    id: name,
    name,
    dailyQuota: quota,
    target,
    covered,
    deficit,
    floor,
    urgentDeficit: Math.max(0, floor - covered),
    daysOfCover: quota > 0 ? Math.round((covered / quota) * 10) / 10 : 0,
    scope: { bu: [], verticals: [], regions: [], ...scope },
  };
};
const plan = (...people) => ({
  people,
  totalTarget: people.reduce((n, p) => n + p.target, 0),
  totalDeficit: people.reduce((n, p) => n + p.deficit, 0),
  unfillable: [],
});
const tally = (order) => {
  const t = {};
  for (const p of order) t[p.name] = (t[p.name] ?? 0) + 1;
  return t;
};

console.log('\nThe real roster shape: one wide scope, one narrow');
{
  // Anas 50/day short 1190; Ronniel 10/day short 233 — the live figures.
  const p = plan(person('anas', 50, 1190), person('ronniel', 10, 233, { verticals: ['mining'] }));
  const t = tally(fillOrder(p, 10));
  check('the narrow scope is served at all', (t.ronniel ?? 0) > 0, JSON.stringify(t));
  /*
    Proportional, but to the URGENT deficit now that the three-day floor is served
    first — both of these are below their floor, and the weights are 140:23 rather
    than the monthly 1190:233. The split moved from 8/2 to 9/1 for that reason.
    The property that matters is unchanged: the narrow scope is still served and
    still not swamped.
  */
  check('and in proportion, not swamped', t.anas === 9 && t.ronniel === 1, JSON.stringify(t));
  check('the slots add up', (t.anas ?? 0) + (t.ronniel ?? 0) === 10, JSON.stringify(t));
}

console.log('\nA tiny share is never rounded out of existence');
{
  // 1% of the deficit. A pure proportional split floors this to zero.
  const p = plan(person('big', 100, 9900), person('tiny', 1, 100));
  const t = tally(fillOrder(p, 10));
  check('tiny still gets a slot', (t.tiny ?? 0) >= 1, JSON.stringify(t));
  check('and big keeps the rest', t.big === 9, JSON.stringify(t));
}

console.log('\nFewer slots than people');
{
  const p = plan(person('a', 50, 1000), person('b', 10, 200), person('c', 10, 200));
  const t = tally(fillOrder(p, 2));
  check('exactly the slots available are handed out', Object.values(t).reduce((x, y) => x + y, 0) === 2, JSON.stringify(t));
  check('and the largest deficit is served first', (t.a ?? 0) >= 1, JSON.stringify(t));
}

console.log('\nOrder is interleaved, not blocked');
{
  // A batch cut short by a timeout must have produced something for everybody,
  // not everything for whoever sorted first.
  const p = plan(person('a', 50, 1190), person('b', 10, 233));
  const order = fillOrder(p, 10).map((x) => x.name);
  check('the second person appears within the first three picks', order.slice(0, 3).includes('b'), order.join(','));
}

console.log('\nNobody short, nothing to do');
{
  check('a satisfied roster produces no slots', fillOrder(plan(person('a', 50, 0)), 10).length === 0);
  check('zero slots produces nothing', fillOrder(plan(person('a', 50, 500)), 0).length === 0);
  check('an empty roster produces nothing', fillOrder(plan(), 10).length === 0);
}

console.log('\nEqual deficits split evenly');
{
  const p = plan(person('a', 10, 240), person('b', 10, 240), person('c', 10, 240));
  const t = tally(fillOrder(p, 9));
  check('three equal people get three each', t.a === 3 && t.b === 3 && t.c === 3, JSON.stringify(t));
}

console.log('\nThe three-day floor is served before the month’s share');
{
  /*
    Both people are short of their monthly share; only one is below the level at
    which they stop working. Splitting by the monthly share treats those as
    different sizes of the same need, so the empty desk waits its proportional
    turn while somebody with eight days of stock is topped up.
  */
  const empty = person('empty', 25, 600); // covered 0   — below the 75 floor
  const stocked = person('stocked', 25, 400); // covered 200 — well above it
  const t = tally(fillOrder(plan(empty, stocked), 20));
  check('every slot goes to the desk below its floor', t.empty === 20, JSON.stringify(t));
  check('and none to the stocked one', !t.stocked, JSON.stringify(t));

  // Once every floor is met, the monthly share decides again — which is what it
  // was always for.
  const a = person('a', 25, 520); // covered 80  — above the floor
  const b = person('b', 25, 300); // covered 300 — above it
  const t2 = tally(fillOrder(plan(a, b), 20));
  check('with floors met, both are served', (t2.a ?? 0) > 0 && (t2.b ?? 0) > 0, JSON.stringify(t2));
  check('the slots still add up', (t2.a ?? 0) + (t2.b ?? 0) === 20, JSON.stringify(t2));
  check('and the bigger monthly shortfall takes more', (t2.a ?? 0) > (t2.b ?? 0), JSON.stringify(t2));

  // The floor scales with the quota, so a small desk needs less to be safe.
  const small = person('small', 5, 120); // covered 0, floor 15
  const large = person('large', 50, 1195); // covered 5, floor 150
  const t3 = tally(fillOrder(plan(small, large), 10));
  check('the larger draw takes more of the urgent slots', (t3.large ?? 0) > (t3.small ?? 0), JSON.stringify(t3));
  check('but the small desk is not starved', (t3.small ?? 0) >= 1, JSON.stringify(t3));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
