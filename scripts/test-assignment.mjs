/**
 * Assignment, against the REAL engine.
 *
 *   node --experimental-transform-types --import ./scripts/lib/register-alias.mjs \
 *     scripts/test-assignment.mjs
 *
 * This file used to carry its own JavaScript copy of the matching, scoping and
 * distribution logic and test that. 29 assertions, not one reference to `src` —
 * so it passed whatever the shipped code did, and could only fail if somebody
 * broke the test. It was exercising `assignLeads`, which had no callers and has
 * now been deleted; the engine the app runs is `planAllocation`.
 *
 * Distribution is where unfairness hides — a subtle bug hands one person every
 * lead, quietly exceeds a quota, or gives somebody a lead outside their patch —
 * which is exactly why the test has to touch the real thing.
 *
 * `test-allocation.mjs` covers the mix/share policy and `test-allocation-fallback.mjs`
 * the roster fallback. This covers load balancing, quota, scope, rule ordering
 * and eligibility.
 */

import { planAllocation } from '../src/lib/allocation.ts';

/**
 * Authored rules only, with the roster fallback disabled.
 *
 * `planAllocation` always appends `ROSTER_FALLBACK_RULE`, so a lead matching no
 * authored rule still reaches anyone who covers it. That is deliberate and
 * covered elsewhere. Most cases here are about what a SPECIFIC rule does, and
 * the fallback would mask a rule that failed to match by placing the lead
 * anyway. Giving every user a role no rule targets isolates a ROLE-targeted
 * rule under test.
 *
 * It does NOT isolate against the fallback itself, which has `toRole: null` —
 * "anyone who covers it" — so an odd role does not exclude anybody from it. To
 * shut the fallback out entirely, put the lead outside every user's scope.
 */
const NO_FALLBACK_ROLE = 'unrostered';

const lead = (id, o = {}) => ({
  id,
  bu: 'uk',
  vertical: 'data_center',
  country: 'GB',
  priority_band: 'P2',
  priority_score: 50,
  estimated_value: null,
  stage: 'act_now',
  contact_status: 'has_contact',
  owner_user_id: null,
  ...o,
});
const user = (id, o = {}) => ({
  id,
  role: 'sdr',
  bu: [],
  verticals: [],
  regions: [],
  dailyQuota: 10,
  assignedToday: 0,
  isActive: true,
  ...o,
});
const rule = (id, priority, conditions, target) => ({
  id,
  name: id,
  priority,
  enabled: true,
  conditions,
  toRole: null,
  toUserId: null,
  ...target,
});

let pass = 0;
let fail = 0;
const t = (name, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log('  PASS', name);
  } else {
    fail += 1;
    console.log('  FAIL', name, detail ? '— ' + detail : '');
  }
};
const countBy = (assignments) => {
  const c = {};
  for (const a of assignments) c[a.userId] = (c[a.userId] ?? 0) + 1;
  return c;
};

console.log('Load balancing');
{
  const leads = Array.from({ length: 9 }, (_, i) => lead('l' + i));
  const out = planAllocation(leads, [rule('r', 1, {}, { toRole: 'sdr' })], [user('a'), user('b'), user('c')]);
  const c = countBy(out.assignments);
  t('spreads evenly across equal owners', c.a === 3 && c.b === 3 && c.c === 3, JSON.stringify(c));
}
{
  const leads = Array.from({ length: 6 }, (_, i) => lead('l' + i));
  const users = [user('busy', { assignedToday: 5 }), user('free', { assignedToday: 0 })];
  const out = planAllocation(leads, [rule('r', 1, {}, { toRole: 'sdr' })], users);
  const free = out.assignments.filter((a) => a.userId === 'free').length;
  t('favours the owner with more headroom', free > out.assignments.length - free, JSON.stringify(countBy(out.assignments)));
}

console.log('\nQuota is never exceeded');
{
  const leads = Array.from({ length: 20 }, (_, i) => lead('l' + i));
  const users = [user('a', { dailyQuota: 3 }), user('b', { dailyQuota: 2 })];
  const out = planAllocation(leads, [rule('r', 1, {}, { toRole: 'sdr' })], users);
  const c = countBy(out.assignments);
  t('respects each owner’s quota', c.a === 3 && c.b === 2, JSON.stringify(c));
  t('assigns no more than total capacity', out.assignments.length === 5, String(out.assignments.length));
  // The 15 that could not be placed are reported somewhere — at capacity, or
  // held by the mix policy. What must never happen is silent disappearance.
  t(
    'every unplaced lead is accounted for',
    out.assignments.length + out.atCapacity + out.unassigned + out.heldForMix === 20,
    `placed ${out.assignments.length}, atCapacity ${out.atCapacity}, unassigned ${out.unassigned}, heldForMix ${out.heldForMix}`
  );
}
{
  const leads = Array.from({ length: 5 }, (_, i) => lead('l' + i));
  const out = planAllocation(leads, [rule('r', 1, {}, { toRole: 'sdr' })], [user('a', { assignedToday: 10, dailyQuota: 10 })]);
  t('an owner already at quota receives nothing', out.assignments.length === 0);
}

console.log('\nScope is respected');
{
  const leads = [lead('uk', { bu: 'uk' }), lead('usa', { bu: 'usa' })];
  const out = planAllocation(leads, [rule('r', 1, {}, { toRole: 'sdr' })], [user('ukOnly', { bu: ['uk'] })]);
  t(
    'a scoped owner only gets leads in their BU',
    out.assignments.length === 1 && out.assignments[0].leadId === 'uk',
    JSON.stringify(out.assignments)
  );
}
{
  const out = planAllocation([lead('l')], [rule('r', 1, {}, { toRole: 'sdr' })], [user('a')]);
  t('an empty scope means no restriction, not no leads', out.assignments.length === 1);
}
{
  const out = planAllocation([lead('l')], [rule('r', 1, {}, { toRole: 'sdr' })], [user('a', { isActive: false })]);
  t('an inactive owner receives nothing', out.assignments.length === 0);
}

console.log('\nRule ordering and targeting');
{
  const rules = [rule('low', 2, {}, { toRole: 'bdr' }), rule('high', 1, { stage: ['act_now'] }, { toRole: 'sdr' })];
  const out = planAllocation([lead('l')], rules, [user('s', { role: 'sdr' }), user('b', { role: 'bdr' })]);
  t('the highest-priority matching rule wins', out.assignments[0]?.ruleId === 'high', JSON.stringify(out.assignments));
}
{
  const out = planAllocation([lead('l')], [rule('r', 1, {}, { toUserId: 'named' })], [user('named'), user('other')]);
  t('a named target receives the lead', out.assignments[0]?.userId === 'named');
}
{
  // Out of scope for the named target — and every other user is unrostered, so
  // the fallback cannot quietly place it and hide the skip.
  const out = planAllocation(
    [lead('l', { bu: 'usa' })],
    [rule('r', 1, {}, { toUserId: 'named' })],
    [user('named', { bu: ['uk'], role: NO_FALLBACK_ROLE })]
  );
  t('a named target outside scope is skipped, not forced', out.assignments.length === 0, JSON.stringify(out.assignments));
}

console.log('\nPriority and eligibility');
{
  const leads = [lead('weak', { priority_score: 10 }), lead('strong', { priority_score: 95 })];
  const out = planAllocation(leads, [rule('r', 1, {}, { toRole: 'sdr' })], [user('a', { dailyQuota: 1 })]);
  t('the strongest lead is placed when capacity is scarce', out.assignments[0]?.leadId === 'strong', JSON.stringify(out.assignments));
}
{
  const leads = [lead('no', { contact_status: 'needs_enrichment' }), lead('yes')];
  // Only the authored rule can place anything: the fallback would take the
  // unenriched lead too and the condition would look broken when it is not.
  const out = planAllocation(leads, [rule('r', 1, { requiresContact: true }, { toRole: 'sdr' })], [user('a')]);
  const ids = out.assignments.filter((a) => a.ruleId === 'r').map((a) => a.leadId);
  t('requiresContact excludes unenriched leads from that rule', ids.length === 1 && ids[0] === 'yes', JSON.stringify(out.assignments));
}
{
  const out = planAllocation([lead('l', { owner_user_id: 'someone' })], [rule('r', 1, {}, { toRole: 'sdr' })], [user('a')]);
  t('an already-owned lead is never reassigned', out.assignments.length === 0);
}
{
  // A disabled rule must place nothing UNDER THAT RULE. It does not mean the
  // lead goes nowhere: the roster fallback still catches it, which is the
  // shipped behaviour and the point of the current design. Asserting
  // `assignments.length === 0` here is what the old self-contained test did,
  // and it was asserting the behaviour of an engine nobody runs.
  //
  // Note the fallback cannot be isolated by giving users an odd role, the way
  // the role-targeted rules above are: ROSTER_FALLBACK_RULE has `toRole: null`,
  // meaning anyone who covers the lead.
  const out = planAllocation(
    [lead('l')],
    [{ ...rule('r', 1, {}, { toRole: 'sdr' }), enabled: false }],
    [user('a', { role: NO_FALLBACK_ROLE })]
  );
  const byDisabled = out.assignments.filter((a) => a.ruleId === 'r');
  t('a disabled rule places nothing itself', byDisabled.length === 0, JSON.stringify(out.assignments));
  t('but the lead is not lost — the fallback takes it', out.assignments[0]?.ruleId === 'roster_fallback');
}
{
  const users = [user('a'), user('b')];
  const before = JSON.stringify(users);
  planAllocation(
    Array.from({ length: 5 }, (_, i) => lead('l' + i)),
    [rule('r', 1, {}, { toRole: 'sdr' })],
    users
  );
  t('the caller’s user objects are not mutated', JSON.stringify(users) === before);
}
{
  const out = planAllocation(
    Array.from({ length: 30 }, (_, i) => lead('l' + i)),
    [rule('a', 1, {}, { toRole: 'sdr' }), rule('b', 2, {}, { toRole: 'bdr' })],
    [user('s', { role: 'sdr' }), user('d', { role: 'bdr' })]
  );
  const ids = out.assignments.map((a) => a.leadId);
  t('no lead is assigned twice', new Set(ids).size === ids.length);
}

console.log('\nThe behaviour the deleted engine got wrong');
{
  // `assignLeads` counted this as `unassigned` and dropped it. The shipped
  // engine hands it to anyone on the roster who covers it — leads flow as soon
  // as a person exists, which is the point of the current design.
  const out = planAllocation([lead('l')], [rule('r', 1, { bu: ['nowhere'] }, { toRole: 'sdr' })], [user('a')]);
  t('a lead matching no authored rule still reaches somebody', out.assignments.length === 1, JSON.stringify(out.assignments));
  t('and it is attributed to the fallback', out.assignments[0]?.ruleId === 'roster_fallback', out.assignments[0]?.ruleId);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
