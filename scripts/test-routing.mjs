/**
 * Routing engine checks — run against the REAL src/lib/routing.ts, not a copy.
 *
 * These pin the contract the rule builder depends on. The builder can only
 * produce rules out of selects and chips, so what matters is that the shapes it
 * emits mean what the UI says they mean: an untouched field must be ignored
 * rather than matching nothing, order must decide ties, and a disabled rule
 * must be invisible to routing without being deleted.
 *
 *   node --experimental-strip-types scripts/test-routing.mjs
 */

import { route, validateRules, DEFAULT_RULES } from '../src/lib/routing.ts';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}
function group(name) {
  console.log(`\n${name}`);
}

/** A record with every field the engine reads, so tests vary one thing at a time. */
function rec(over = {}) {
  return {
    bu: 'uk',
    icp_code: 'tier1_gc',
    vertical: 'data_center',
    record_type: 'project',
    contact_status: 'has_contact',
    population_percentage: 80,
    country: 'United Kingdom',
    key_account: false,
    key_account_score: 50,
    priority_score: 70,
    priority_band: 'P2',
    ...over,
  };
}
const to = (route_, stage) => ({ route: route_, stage });

group('An untouched field is ignored, not treated as "match nothing"');
check(
  'empty match catches every record',
  route(rec(), [{ name: 'catch-all', match: {}, assign: to('sales', 'qualify') }]).reason === 'catch-all'
);
check(
  'empty array behaves like "any"',
  route(rec({ bu: 'usa' }), [{ name: 'any-bu', match: { bu: [] }, assign: to('sales', 'qualify') }]).reason === 'any-bu'
);
check(
  'a match on one field ignores the others',
  route(rec({ bu: 'usa', vertical: 'mining' }), [
    { name: 'usa only', match: { bu: ['usa'] }, assign: to('sales', 'act_now') },
  ]).stage === 'act_now'
);

group('List clauses are any-of');
const buRule = [{ name: 'uk or ie', match: { bu: ['uk', 'ireland'] }, assign: to('sales', 'qualify') }];
check('first value matches', route(rec({ bu: 'uk' }), buRule).reason === 'uk or ie');
check('second value matches', route(rec({ bu: 'ireland' }), buRule).reason === 'uk or ie');
check('a value outside the list falls through', route(rec({ bu: 'apac' }), buRule).reason === 'default');
check(
  'a null field never matches a non-empty list',
  route(rec({ bu: null }), buRule).reason === 'default'
);

group('Order decides — first match wins');
const ordered = [
  { name: 'first', match: { priorityBands: ['P2'] }, assign: to('sales', 'act_now') },
  { name: 'second', match: { priorityBands: ['P2'] }, assign: to('marketing', 'nurture') },
];
check('the earlier rule wins', route(rec(), ordered).reason === 'first');
check('reordering changes the outcome', route(rec(), [ordered[1], ordered[0]]).reason === 'second');

group('Disabled rules are skipped without being deleted');
check(
  'enabled:false is invisible to routing',
  route(rec(), [
    { name: 'off', enabled: false, match: {}, assign: to('none', 'disqualify') },
    { name: 'on', match: {}, assign: to('sales', 'qualify') },
  ]).reason === 'on'
);
check(
  'an absent enabled key means active',
  route(rec(), [{ name: 'no key', match: {}, assign: to('sales', 'qualify') }]).reason === 'no key'
);
check(
  'enabled:true is active',
  route(rec(), [{ name: 'explicit', enabled: true, match: {}, assign: to('sales', 'qualify') }]).reason === 'explicit'
);

group('Booleans distinguish "no" from "any"');
const notKey = [{ name: 'exclude key accounts', match: { keyAccount: false }, assign: to('marketing', 'nurture') }];
check('keyAccount:false matches a non-key account', route(rec({ key_account: false }), notKey).reason.startsWith('exclude'));
check('keyAccount:false excludes a key account', route(rec({ key_account: true }), notKey).reason === 'default');
check(
  'an absent keyAccount matches both',
  route(rec({ key_account: true }), [{ name: 'any', match: {}, assign: to('sales', 'qualify') }]).reason === 'any'
);

group('Numeric bounds are inclusive');
const atLeast70 = [{ name: 'hot', match: { minPriority: 70 }, assign: to('sales', 'act_now') }];
check('a score equal to the floor matches', route(rec({ priority_score: 70 }), atLeast70).reason === 'hot');
check('a score below the floor does not', route(rec({ priority_score: 69 }), atLeast70).reason === 'default');
const atMost30 = [{ name: 'cold', match: { maxPriority: 30 }, assign: to('none', 'hold') }];
check('a score equal to the ceiling matches', route(rec({ priority_score: 30 }), atMost30).reason === 'cold');
check('a score above the ceiling does not', route(rec({ priority_score: 31 }), atMost30).reason === 'default');
check(
  'a floor and a ceiling form a band',
  route(rec({ priority_score: 50 }), [
    { name: 'mid', match: { minPriority: 40, maxPriority: 60 }, assign: to('sales', 'qualify') },
  ]).reason === 'mid'
);
check(
  'a missing score counts as zero',
  route(rec({ priority_score: null }), atLeast70).reason === 'default'
);

group('Team assignment');
check(
  '$bu resolves to the record own BU',
  route(rec({ bu: 'apac' }), [{ name: 'r', match: {}, assign: { ...to('sales', 'qualify'), team: '$bu' } }]).team ===
    'apac'
);
check(
  'a literal team is used as-is',
  route(rec(), [{ name: 'r', match: {}, assign: { ...to('sales', 'qualify'), team: 'usa' } }]).team === 'usa'
);
check('no team means unassigned', route(rec(), [{ name: 'r', match: {}, assign: to('sales', 'qualify') }]).team === null);

group('Fallthrough');
const fell = route(rec(), []);
check('an empty policy routes to the default lane', fell.route === 'marketing' && fell.stage === 'nurture');
check('the default disposition is named "default"', fell.reason === 'default');
check('nothing matched still yields a disposition', route(rec({ bu: 'nowhere' }), buRule).route === 'marketing');

group('Validation accepts what the builder emits');
check('the shipped defaults validate', validateRules(DEFAULT_RULES).ok === true);
check(
  'a fully-specified rule validates',
  validateRules([
    {
      name: 'everything set',
      enabled: false,
      match: {
        priorityBands: ['P1', 'P2'],
        record_type: ['project'],
        bu: ['uk'],
        icp: ['tier1_gc'],
        vertical: ['data_center'],
        country: ['United Kingdom'],
        keyAccount: true,
        contactStatus: 'has_contact',
        minPriority: 0,
        maxPriority: 100,
        minScore: 10,
        minCompleteness: 50,
      },
      assign: { route: 'sales', stage: 'act_now', team: '$bu', sla_hours: 8 },
    },
  ]).ok === true
);
check('an empty policy validates', validateRules([]).ok === true);

group('Validation rejects what the builder cannot produce');
check('a non-array is rejected', validateRules({}).ok === false);
check('a missing name is rejected', validateRules([{ match: {}, assign: to('sales', 'qualify') }]).ok === false);
check('a missing match is rejected', validateRules([{ name: 'x', assign: to('sales', 'qualify') }]).ok === false);
check(
  'an unknown route is rejected',
  validateRules([{ name: 'x', match: {}, assign: { route: 'ops', stage: 'qualify' } }]).ok === false
);
check(
  'an unknown stage is rejected',
  validateRules([{ name: 'x', match: {}, assign: { route: 'sales', stage: 'ship_it' } }]).ok === false
);
check(
  'an unknown priority band is rejected',
  validateRules([{ name: 'x', match: { priorityBands: ['P5'] }, assign: to('sales', 'qualify') }]).ok === false
);
check(
  'a priority above 100 is rejected',
  validateRules([{ name: 'x', match: { minPriority: 101 }, assign: to('sales', 'qualify') }]).ok === false
);
check(
  'a negative priority is rejected',
  validateRules([{ name: 'x', match: { maxPriority: -1 }, assign: to('sales', 'qualify') }]).ok === false
);

group('The shipped defaults behave as documented');
check(
  'P4 is parked before anything else looks at it',
  route(rec({ priority_band: 'P4', key_account: true }), DEFAULT_RULES).route === 'none'
);
check(
  'news goes to marketing awareness',
  route(rec({ record_type: 'news', priority_band: 'P1' }), DEFAULT_RULES).route === 'marketing'
);
check(
  'a key account with a contact is act-now',
  route(rec({ key_account: true, contact_status: 'has_contact' }), DEFAULT_RULES).stage === 'act_now'
);
check(
  'a key account without a contact qualifies first',
  route(rec({ key_account: true, contact_status: 'needs_enrichment' }), DEFAULT_RULES).stage === 'qualify'
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
