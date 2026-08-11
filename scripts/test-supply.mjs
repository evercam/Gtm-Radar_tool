/**
 * Three days of leads on every working desk.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-supply.mjs
 *
 * The reason this is per person rather than per team: a healthy average hides an
 * empty desk. Four people at three days each and three people at four days with
 * one at nothing produce the same team figure, and in the second case somebody
 * has stopped working.
 *
 * The two cases that would waste money are inactive people and zero quotas. Most
 * of this roster is inactive, so counting their empty desks as shortfall would
 * ask enrichment to spend Apollo credits supplying people who are not working.
 *
 * Pure — no network, no database.
 */

import { planSupply, enrichmentAsk, describeSupply, MIN_DAYS_OF_COVER } from '@/lib/supply';

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

const p = (name, dailyQuota, covered, isActive = true) => ({ assigneeId: name, name, dailyQuota, covered, isActive });

console.log('The floor is three days of that person’s own draw');
{
  check('the default is three days', MIN_DAYS_OF_COVER === 3);

  const plan = planSupply([p('Big', 25, 0), p('Small', 5, 0)]);
  const big = plan.people.find((x) => x.name === 'Big');
  const small = plan.people.find((x) => x.name === 'Small');
  /*
    One number cannot serve both. Somebody drawing 25 a day needs 75 to have
    three days of work; somebody drawing 5 needs 15.
  */
  check('25/day needs 75', big.target === 75, String(big.target));
  check('5/day needs 15', small.target === 15, String(small.target));
  check('both are short', plan.shortCount === 2);
  check('the deficits add up', plan.totalDeficit === 90, String(plan.totalDeficit));
}

console.log('\nCover is measured, not assumed');
{
  const plan = planSupply([p('Full', 25, 100), p('Exact', 25, 75), p('Thin', 25, 30), p('Empty', 25, 0)]);
  const by = Object.fromEntries(plan.people.map((x) => [x.name, x]));
  check('100 in scope on a 25 draw is 4 days', by.Full.daysOfCover === 4);
  check('and is not short', !by.Full.short && by.Full.deficit === 0);
  check('exactly 75 is covered, not short', !by.Exact.short, `deficit ${by.Exact.deficit}`);
  check('30 in scope is 1.2 days', by.Thin.daysOfCover === 1.2, String(by.Thin.daysOfCover));
  check('and needs 45 more', by.Thin.deficit === 45, String(by.Thin.deficit));
  check('an empty desk needs the full 75', by.Empty.deficit === 75);
  check('two people are short', plan.shortCount === 2, String(plan.shortCount));

  // The thinnest desk empties first, so it is the one to read.
  check('the thinnest is reported first', plan.people[0].name === 'Empty', plan.people[0].name);
  check('and named on the plan', plan.thinnest.name === 'Empty');
}

console.log('\nNobody is supplied who is not working');
{
  /*
    Most of this roster is inactive. Counting their empty desks as shortfall would
    ask enrichment to spend Apollo credits on people who draw nothing.
  */
  const plan = planSupply([p('Working', 25, 75), p('Dormant', 25, 0, false)]);
  check('inactive people are excluded', plan.people.length === 1, String(plan.people.length));
  check('their empty desk is not a deficit', plan.totalDeficit === 0, String(plan.totalDeficit));

  // A zero quota means "sends nothing", not "needs everything" — and dividing by
  // it would report infinite need.
  const zero = planSupply([p('NoQuota', 0, 0)]);
  check('a zero quota is excluded', zero.people.length === 0);
  check('and asks for nothing', zero.totalDeficit === 0);

  const none = planSupply([]);
  check('an empty roster is not a crisis', none.shortCount === 0 && none.thinnest === null);
  check('and describes as nothing', describeSupply(none) === null);
}

console.log('\nThe enrichment ask allows for what will not land');
{
  /*
    The shortfall is in READY leads — assigned and reachable. Enrichment produces
    neither directly: it makes a record contactable and assignment has to pick it
    up. Some never become anybody's ready lead, because no contact was found or
    nobody's scope covers them.
  */
  const plan = planSupply([p('A', 25, 0)]); // deficit 75
  check('a deficit of 75 asks for 113 at 50% wastage', enrichmentAsk(plan) === 113, String(enrichmentAsk(plan)));
  check('no wastage asks for exactly the deficit', enrichmentAsk(plan, { wastage: 0 }) === 75);
  check('the cap wins when lower', enrichmentAsk(plan, { cap: 40 }) === 40);
  check('a cap above the ask does nothing', enrichmentAsk(plan, { cap: 10_000 }) === 113);
  check('a negative wastage is treated as none', enrichmentAsk(plan, { wastage: -1 }) === 75);

  // Nothing to do must ask for nothing, or every run spends money.
  const covered = planSupply([p('A', 25, 200)]);
  check('a covered team asks for nothing', enrichmentAsk(covered) === 0);
  check('and a zero cap asks for nothing', enrichmentAsk(plan, { cap: 0 }) === 0);
}

console.log('\nThe summary line is worth reading');
{
  check('covered reads as covered', /at least 3 days/.test(describeSupply(planSupply([p('A', 25, 100)]))));
  const one = describeSupply(planSupply([p('A', 25, 25), p('B', 25, 100)]));
  check('one short names them', /^A has 1 day/.test(one), one);
  const many = describeSupply(planSupply([p('A', 25, 0), p('B', 25, 25)]));
  check('several short name the thinnest', /2 people are below 3 days, the thinnest being A/.test(many), many);
  check('and state the total needed', /125 more ready lead/.test(many), many);
}

console.log('\nA custom floor is honoured, a nonsense one is not');
{
  check('five days on a 10 draw is 50', planSupply([p('A', 10, 0)], 5).people[0].target === 50);
  check('zero falls back to the default', planSupply([p('A', 10, 0)], 0).minDays === 3);
  check('negative falls back', planSupply([p('A', 10, 0)], -2).minDays === 3);
  check('NaN falls back', planSupply([p('A', 10, 0)], Number.NaN).minDays === 3);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
