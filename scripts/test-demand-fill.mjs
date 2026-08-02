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

const person = (name, quota, deficit, scope = {}) => ({
  id: name,
  name,
  dailyQuota: quota,
  target: quota * 24,
  covered: quota * 24 - deficit,
  deficit,
  scope: { bu: [], verticals: [], regions: [], ...scope },
});
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
  check('and in proportion to the deficit, not swamped', t.anas === 8 && t.ronniel === 2, JSON.stringify(t));
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
