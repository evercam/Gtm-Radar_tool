/**
 * Enrichment policy checks — run against the REAL src/lib/enrich/policy.ts.
 *
 * This policy is the only thing standing between a mis-typed number and a
 * five-figure Apollo bill, so the tests care about one question: can a saved
 * policy ever be MORE permissive than the person editing it intended? Merge
 * must clamp, validation must reject the combinations that would silently
 * disable a rail, and an absent field must fall back to the default rather
 * than to zero — because zero means "no cap".
 *
 *   node --experimental-strip-types scripts/test-enrichment-policy.mjs
 */

import {
  DEFAULT_ENRICHMENT_POLICY as D,
  mergeEnrichmentPolicy as merge,
  validateEnrichmentPolicy as validate,
} from '../src/lib/enrich/policy.ts';

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
const group = (n) => console.log(`\n${n}`);

group('A partial policy falls back to defaults, never to zero');
check('an empty object yields the defaults', merge({}).dailyCap === D.dailyCap);
check('a missing monthlyCap is not treated as "no cap"', merge({ dailyCap: 5 }).monthlyCap === D.monthlyCap);
check('a missing minPriorityScore keeps the default floor', merge({}).minPriorityScore === D.minPriorityScore);
check('null is not an object policy', merge(null).batchSize === D.batchSize);
check('a string is rejected wholesale', merge('nope').concurrency === D.concurrency);
check('unknown keys are dropped', merge({ nonsense: 1 }).batchSize === D.batchSize);

group('New eligibility fields default to "no extra restriction"');
check('bus defaults to empty (all business units)', merge({}).bus.length === 0);
check('verticals defaults to empty (all verticals)', merge({}).verticals.length === 0);
check('minEstimatedValue defaults to 0 (disabled)', merge({}).minEstimatedValue === 0);
check('requireCompany defaults on — Apollo needs a company', merge({}).requireCompany === true);
check('a saved bus list survives the merge', merge({ bus: ['uk', 'usa'] }).bus.join() === 'uk,usa');
check('a non-string list is discarded, not coerced', merge({ bus: [1, 2] }).bus.length === 0);

group('Numbers are clamped to their documented range');
check('concurrency is capped at 10', merge({ concurrency: 999 }).concurrency === 10);
check('concurrency has a floor of 1', merge({ concurrency: 0 }).concurrency === 1);
check('minPriorityScore cannot exceed 100', merge({ minPriorityScore: 5000 }).minPriorityScore === 100);
check('a negative minEstimatedValue clamps to 0', merge({ minEstimatedValue: -5 }).minEstimatedValue === 0);
check('contactsPerAccount is capped at 25', merge({ contactsPerAccount: 100 }).contactsPerAccount === 25);
check('batchSize cannot exceed maxBatchSize', merge({ batchSize: 500, maxBatchSize: 20 }).batchSize === 20);
check('a fractional value is rounded, not truncated to NaN', merge({ concurrency: 2.6 }).concurrency === 3);
check('NaN falls back to the default', merge({ dailyCap: NaN }).dailyCap === D.dailyCap);
check('Infinity falls back to the default', merge({ dailyCap: Infinity }).dailyCap === D.dailyCap);

group('Contact targeting');
check('seniorities default to the decision-maker set', merge({}).contactSeniorities.includes('c_suite'));
check('an empty seniority list is allowed — Apollo then returns any level', merge({ contactSeniorities: [] }).contactSeniorities.length === 0);
check('fallbackTitles default to empty', merge({}).fallbackTitles.length === 0);
check('fallbackTitles survive', merge({ fallbackTitles: ['Head of Construction'] }).fallbackTitles.length === 1);

group('Validation rejects a policy that would silently enrich nothing');
check('no eligible band is rejected', validate({ ...D, bands: [] }).ok === false);
check('no eligible record type is rejected', validate({ ...D, recordTypes: [] }).ok === false);
check('an unknown band is rejected', validate({ ...D, bands: ['P9'] }).ok === false);
check('a valid band subset passes', validate({ ...D, bands: ['P1'] }).ok === true);

group('Validation rejects a policy that would silently disable a rail');
check(
  'a daily cap above the monthly cap is rejected',
  validate({ ...D, dailyCap: 5000, monthlyCap: 100 }).ok === false
);
check('a daily cap under the monthly cap passes', validate({ ...D, dailyCap: 100, monthlyCap: 5000 }).ok === true);
check('a zero monthly cap disables the check rather than failing', validate({ ...D, dailyCap: 900, monthlyCap: 0 }).ok === true);
check('batchSize above maxBatchSize is rejected', validate({ ...D, batchSize: 50, maxBatchSize: 10 }).ok === false);
check('turning off both paid engines is rejected', validate({ ...D, engines: { claude: false, apollo: false, gleif: true } }).ok === false);
check('turning off just Apollo is allowed', validate({ ...D, engines: { claude: true, apollo: false, gleif: true } }).ok === true);

group('Validation rejects values the providers would not understand');
check('an unknown seniority is rejected', validate({ ...D, contactSeniorities: ['wizard'] }).ok === false);
check('a known seniority passes', validate({ ...D, contactSeniorities: ['vp', 'director'] }).ok === true);
check('a negative daily cap is rejected', validate({ ...D, dailyCap: -1 }).ok === false);
check('a negative minimum value is rejected', validate({ ...D, minEstimatedValue: -1 }).ok === false);
check('concurrency below 1 is rejected', validate({ ...D, concurrency: 0 }).ok === false);
check('a non-object is rejected', validate([]).ok === false);

group('The shipped defaults are internally consistent');
check('the defaults validate', validate(D).ok === true);
check('the defaults survive a merge unchanged', JSON.stringify(merge(D)) === JSON.stringify(D));
check('the default daily cap fits inside the monthly cap', D.dailyCap <= D.monthlyCap);
check('the default batch fits inside the max batch', D.batchSize <= D.maxBatchSize);
check('at least one paid engine is on by default', D.engines.claude || D.engines.apollo);
check('the defaults restrict to high-priority bands', D.bands.length > 0 && D.bands.length < 4);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
