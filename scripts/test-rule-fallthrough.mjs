/**
 * A rule whose recipient cannot take the lead must not drop it.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-rule-fallthrough.mjs
 *
 * `planAllocation` used to resolve the FIRST matching rule and stop. If that
 * rule named someone whose scope did not cover the lead — or who was inactive, or
 * out of quota — the lead ended up with no owner, even though a later rule or the
 * roster fallback would have placed it immediately.
 *
 * Held against the live config that was the common case, not a corner: the top
 * rule targeted one BDR whose vertical scope excluded `construction`, which is
 * 30,477 of 54,346 records. Every act-now construction lead matched that rule,
 * failed its recipient check, and was dropped.
 *
 * What a rule list expresses is "prefer this recipient", not "and if they cannot,
 * nobody". Pure: no database, no network.
 */

import { planAllocation, ROSTER_FALLBACK_RULE } from '@/lib/allocation';

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

const lead = (id, over = {}) => ({
  id,
  bu: 'usa',
  vertical: 'construction',
  country: 'United States',
  priority_score: 80,
  priority_band: 'P1',
  route: 'sales',
  stage: 'act_now',
  contact_status: 'has_contact',
  assigneeId: null,
  owner_user_id: null,
  ...over,
});

const person = (id, over = {}) => ({
  id,
  name: id,
  role: 'bdr',
  bu: [],
  verticals: [],
  regions: [],
  isActive: true,
  assignedToday: 0,
  dailyQuota: 50,
  ...over,
});

// Mirrors the live shape: a top rule aimed at somebody whose scope excludes the
// biggest vertical in the book.
const narrowRule = {
  id: 'r1',
  name: 'Everything act-now to Alex',
  priority: 1,
  enabled: true,
  conditions: { bu: ['usa'], bands: ['P1', 'P2'], route: ['sales'], stage: ['act_now'] },
  toUserId: 'alex',
  toRole: null,
};

console.log('A named recipient who cannot cover the lead does not consume it');
{
  const alex = person('alex', { verticals: ['solar', 'wind'] }); // no 'construction'
  const jo = person('jo'); // unscoped — covers everything
  const r = planAllocation([lead('L1')], [narrowRule], [alex, jo]);
  check('the lead is still assigned', r.assignments.length === 1, JSON.stringify(r));
  check('to the person who can actually take it', r.assignments[0]?.userId === 'jo', r.assignments[0]?.userId);
  check('credited to the rule that placed it', r.assignments[0]?.ruleId === ROSTER_FALLBACK_RULE.id, r.assignments[0]?.ruleId);
  check('and it is not counted as at-capacity', r.atCapacity === 0, String(r.atCapacity));
}

console.log('\nAn authored rule still wins whenever it CAN be satisfied');
{
  const alex = person('alex', { verticals: ['construction'] });
  const jo = person('jo');
  const r = planAllocation([lead('L1')], [narrowRule], [alex, jo]);
  check('the named recipient gets it', r.assignments[0]?.userId === 'alex', r.assignments[0]?.userId);
  check('and the rule is credited', r.assignments[0]?.ruleId === 'r1', r.assignments[0]?.ruleId);
}

console.log('\nInactive and out-of-quota recipients fall through the same way');
{
  const jo = person('jo');
  const inactive = planAllocation([lead('L1')], [narrowRule], [person('alex', { isActive: false }), jo]);
  check('an inactive named recipient falls through', inactive.assignments[0]?.userId === 'jo', JSON.stringify(inactive.assignments));

  const spent = planAllocation([lead('L1')], [narrowRule], [person('alex', { assignedToday: 50, dailyQuota: 50 }), jo]);
  check('a recipient at quota falls through', spent.assignments[0]?.userId === 'jo', JSON.stringify(spent.assignments));

  const zero = planAllocation([lead('L1')], [narrowRule], [person('alex', { dailyQuota: 0 }), jo]);
  check('a recipient on a zero quota falls through', zero.assignments[0]?.userId === 'jo', JSON.stringify(zero.assignments));
}

console.log('\nPrecedence between two authored rules is preserved');
{
  const second = { ...narrowRule, id: 'r2', name: 'Then Bea', priority: 2, toUserId: 'bea' };
  const alex = person('alex', { verticals: ['solar'] }); // cannot cover
  const bea = person('bea');
  const r = planAllocation([lead('L1')], [narrowRule, second], [alex, bea]);
  check('the next authored rule is tried before the fallback', r.assignments[0]?.ruleId === 'r2', r.assignments[0]?.ruleId);
  check('and its recipient gets the lead', r.assignments[0]?.userId === 'bea');
}

console.log('\nWhen genuinely nobody can take it, it is still reported honestly');
{
  const alex = person('alex', { verticals: ['solar'] });
  const r = planAllocation([lead('L1')], [narrowRule], [alex]);
  check('nothing is assigned', r.assignments.length === 0);
  /*
    Counted as no-coverage: Alex's scope is solar and the lead is not, so his
    quota is irrelevant. This asserted atCapacity, back when the two were one
    number and an operator was pointed at the wrong lever.
  */
  check(
    'and it is counted, not silently lost',
    r.noCoverage === 1,
    JSON.stringify({ atCapacity: r.atCapacity, noCoverage: r.noCoverage, unassigned: r.unassigned })
  );
}

console.log('\nA lead matching no rule at all is still unassigned, not force-fed');
{
  // The fallback has empty conditions, so it matches everything — the only way to
  // match nothing is to have no rules AND no fallback, which cannot happen. What
  // can happen is nobody covering it.
  const r = planAllocation([lead('L1', { bu: 'apac' })], [narrowRule], [person('jo', { bu: ['usa'] })]);
  check('an out-of-scope lead finds no owner', r.assignments.length === 0, JSON.stringify(r.assignments));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
