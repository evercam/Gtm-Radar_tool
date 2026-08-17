/**
 * USASpending: a period of performance, not a single timestamp.
 *
 *   node --experimental-transform-types --import ./scripts/lib/register-alias.mjs \
 *        scripts/test-usaspending.mjs
 *
 * 6,037 stored records, and measured 2026-08-17 every one of them read `on_time` —
 * "mobilising or just started". None was cold. The source was three separate
 * mistakes stacked on each other:
 *
 *   1. `current_phase` was the constant 'Awarded'. Every award carries a start date
 *      in the past, so `arrivalFor` saw a phase claiming work had not begun beside a
 *      past start date, correctly called them contradictory, and kept the phase. The
 *      dates were therefore discarded on all 6,037 records. Of 200 sampled awards,
 *      48 had an END DATE THAT HAD ALREADY PASSED — a quarter of the source was
 *      finished work offered to a seller as ready to mobilise.
 *
 *   2. The query sorted by `Award Amount desc`, which asks for the biggest federal
 *      construction contracts of the year — and the biggest are the oldest. Zero of
 *      100 fell inside the selling window. Sorting by `Start Date desc` returns work
 *      that has not broken ground: 84 of 100 `early`, 13 `too_early`.
 *
 *   3. Fields present on 200 of 200 sampled awards were not requested at all: the
 *      end date, NAICS, PSC, the obligation date. `Awarding Agency Name` WAS
 *      requested and is null on 200 of 200, so the description line "Awarding
 *      agency: …" was empty on every stored record; `Awarding Sub Agency` has the
 *      answer.
 *
 * The payloads below are the real API shape, taken from live responses.
 */

import { usaSpendingAdapter, phaseFromPeriod } from '../src/lib/adapters/usaspending.ts';
import { arrivalFor, isColdArrival } from '../src/lib/arrival.ts';

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

const NOW = new Date('2026-08-17T00:00:00Z').getTime();
const award = (over = {}) => ({
  'Award ID': '70B01C26F00000017',
  'Recipient Name': 'FISHER SAND & GRAVEL CO',
  'Award Amount': 2833494611.7,
  'Total Outlays': 180525933.22,
  Description: 'CONSTRUCT VERTICAL BORDER BARRIER',
  'Contract Award Type': 'DELIVERY ORDER',
  'Awarding Agency Name': null,
  'Awarding Sub Agency': 'U.S. Customs and Border Protection',
  'Start Date': '2026-11-01',
  'End Date': '2028-08-31',
  'Base Obligation Date': '2026-07-02',
  NAICS: { code: '236220', description: 'COMMERCIAL AND INSTITUTIONAL BUILDING CONSTRUCTION' },
  PSC: { code: 'Y1PZ', description: 'CONSTRUCTION OF OTHER NON-BUILDING FACILITIES' },
  recipient_id: 'fa0b2d2c-6660-adbe-e0ea-4035b15e4cbd-C',
  'Place of Performance State Code': 'AZ',
  'Place of Performance Zip5': '85611',
  generated_internal_id: 'CONT_AWD_70B01C26F00000017_7014',
  ...over,
});

console.log('\nThe phase comes from the period of performance');
{
  check('not started yet is Awarded', phaseFromPeriod('2026-11-01', '2028-08-31', NOW) === 'Awarded');
  check('started with work left is Under construction', /under construction/i.test(phaseFromPeriod('2026-01-01', '2028-08-31', NOW)));
  check('a passed end date is Project complete', /complete/i.test(phaseFromPeriod('2024-01-01', '2025-06-30', NOW)));
  check('no dates falls back to Awarded', phaseFromPeriod(null, null, NOW) === 'Awarded');
  // The end date decides even when the start is missing — a finished job is finished.
  check('a passed end date wins over a missing start', /complete/i.test(phaseFromPeriod(null, '2025-06-30', NOW)));
  check('an unparseable date does not become a phase claim', phaseFromPeriod('not-a-date', null, NOW) === 'Awarded');
}

console.log('\nThose phases produce the right verdicts, and the right SPEND');
{
  const future = usaSpendingAdapter.normalize(award({ 'Start Date': '2026-11-01', 'End Date': '2028-08-31' }));
  const a1 = arrivalFor(future, undefined, NOW);
  check('an award starting in under 6 months is early', a1.verdict === 'early', a1.verdict);
  check('and is judged from the start date, not the phase', a1.basis === 'construction_start', a1.basis);
  check('and is warm', !isColdArrival(future, undefined, NOW));

  const midBuild = usaSpendingAdapter.normalize(award({ 'Start Date': '2025-06-01', 'End Date': '2028-08-31' }));
  const a2 = arrivalFor(midBuild, undefined, NOW);
  check('a contract 14 months into its build is NOT on_time', a2.verdict !== 'on_time', a2.verdict);
  check('it is too_late', a2.verdict === 'too_late', a2.verdict);
  check('and cold, so no Apollo credit is spent', isColdArrival(midBuild, undefined, NOW));

  const done = usaSpendingAdapter.normalize(award({ 'Start Date': '2024-01-01', 'End Date': '2025-06-30' }));
  check('a finished contract is too_late', arrivalFor(done, undefined, NOW).verdict === 'too_late');
  check('and cold — this was 24% of the source', isColdArrival(done, undefined, NOW));

  const farOut = usaSpendingAdapter.normalize(award({ 'Start Date': '2028-07-10', 'End Date': '2028-12-15' }));
  check('a start two years out is too_early, not dropped', arrivalFor(farOut, undefined, NOW).verdict === 'too_early');
  check('and NOT cold — it enters the window later', !isColdArrival(farOut, undefined, NOW));
}

console.log('\nThe two dates are two different events');
{
  const r = usaSpendingAdapter.normalize(award());
  check('construction start is the period start', r.construction_start_date === '2026-11-01', r.construction_start_date);
  check('announced is the OBLIGATION date', r.announced_date === '2026-07-02', r.announced_date);
  /*
    Both used to be `Start Date`, so these columns were identical on 300 of 300
    sampled records — the same defect the World Bank adapter had.
  */
  check('they are not the same field written twice', r.construction_start_date !== r.announced_date);
  check('the end date is stored at all', r.estimated_completion_date === '2028-08-31', r.estimated_completion_date);
}

console.log('\nThe fields that were being thrown away');
{
  const r = usaSpendingAdapter.normalize(award());
  check('NAICS becomes the building type', /COMMERCIAL AND INSTITUTIONAL/.test(r.building_type ?? ''), r.building_type);
  check('PSC becomes the project type', /CONSTRUCTION OF OTHER NON-BUILDING/.test(r.project_type ?? ''), r.project_type);
  check('the zip carries the location', r.city === '85611', r.city);
  check('completeness now credits the building type', r.fields_populated.building_type === true);
  check('and credits the timeline', r.fields_populated.project_timeline === true);

  // Awarding Agency Name is null on 200/200; the sub agency is populated on 200/200.
  check('the SUB agency is named', /U\.S\. Customs and Border Protection/.test(r.description ?? ''), r.description?.slice(0, 80));
  check('not an empty "Awarding agency: —"', !/Awarding agency:\s*(—|$)/.test(r.description ?? ''));

  // 180,525,933 / 2,833,494,611 = 6%. A progress proxy a rep can act on.
  check('outlay progress is stated for the call', /Outlaid 6% of the award ceiling/.test(r.description ?? ''), r.description?.slice(-70));
  const noOutlay = usaSpendingAdapter.normalize(award({ 'Total Outlays': null }));
  check('and omitted when unknown rather than shown as 0%', !/Outlaid/.test(noOutlay.description ?? ''));
}

console.log('\nThe value still survives, since budget is why these rank');
{
  const r = usaSpendingAdapter.normalize(award());
  check('award amount is the estimated value', r.estimated_value === 2833494611.7, String(r.estimated_value));
  check('currency is USD', r.estimated_value_currency === 'USD');
  const noAmt = usaSpendingAdapter.normalize(award({ 'Award Amount': null }));
  check('a missing amount is null, not zero', noAmt.estimated_value === null, String(noAmt.estimated_value));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
