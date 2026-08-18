/**
 * SEC EDGAR: read the item codes instead of passing them through.
 *
 *   node --experimental-transform-types --import ./scripts/lib/register-alias.mjs \
 *        scripts/test-sec-edgar.mjs
 *
 * 4,047 stored records, `current_phase` null on every one, and the description
 * reading "Items 1.01, 2.02, 7.01" — a code a seller has to look up.
 *
 * `items` is returned on 100% of 8-K hits and is the only field in this index that
 * says what a filing IS. Measured 2026-08-18 over 600 stored records:
 *
 *   no items at all (10-K, 10-Q)                    50%
 *   PURE earnings — 2.02 and nothing substantive      9%   matched on "data center"
 *                                                          because results discuss it
 *   substantive (1.01 / 2.01 / 7.01 / 8.01)          39%
 *   material definitive agreement (1.01)             11%   the contract signal
 *
 * Nothing is DISCARDED on the strength of a code. A 10-K carries no items and is
 * still a real capex disclosure; an earnings release can still announce a facility.
 * The codes change what a record says, not whether it exists.
 */

import { secEdgarAdapter } from '../src/lib/adapters/sec-edgar.ts';
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

// The real hit shape, from a live response.
const hit = (items, over = {}) => ({
  _id: '0001104659-26-093406:ex992.htm',
  _source: {
    ciks: ['0000320193'],
    display_names: ['EXAMPLE CORP  (EXPL)  (CIK 0000320193)'],
    file_date: '2026-08-10',
    form: '8-K',
    root_forms: ['8-K'],
    file_description: 'EX-99.2',
    biz_locations: ['Castle Rock, CO'],
    biz_states: ['CO'],
    sics: ['6199'],
    adsh: '0001104659-26-093406',
    items,
    ...over,
  },
});

console.log('\nItem codes are named, not numbered');
{
  const r = secEdgarAdapter.normalize(hit(['1.01', '7.01', '9.01']));
  check('the codes are translated', /material definitive agreement/.test(r.description ?? ''), r.description);
  check('all of them, not just the first', /Reg FD disclosure/.test(r.description ?? ''));
  check('and no bare "Items 1.01" survives', !/Items \d\.\d\d/.test(r.description ?? ''), r.description);

  // An unmapped code is still evidence — kept as a number rather than dropped.
  const odd = secEdgarAdapter.normalize(hit(['9.99']));
  check('an unclassified code keeps its number', /item 9\.99/.test(odd.description ?? ''), odd.description);
}

console.log('\nEvery filing gets a phase, so the verdict is not an accident');
{
  /*
    `current_phase` was null on all 4,047 records, so arrivalFor fell through to the
    record-type default for 'filing'. The verdict was right by accident and untunable:
    an admin editing the phase table could not move it, because it was not reading the
    table at all.
  */
  const announced = secEdgarAdapter.normalize(hit(['8.01', '9.01']));
  check('an event filing is an Announcement', announced.current_phase === 'Announcement', String(announced.current_phase));
  check('never null again', announced.current_phase !== null);
  check('and it reads unconfirmed — real, undated', arrivalFor(announced).verdict === 'unconfirmed', arrivalFor(announced).verdict);
  check('warm, because an announcement is an early signal', !isColdArrival(announced));

  // A material definitive agreement means the contract for the thing exists.
  const agreed = secEdgarAdapter.normalize(hit(['1.01', '9.01']));
  check('a material definitive agreement is Awarded', agreed.current_phase === 'Awarded', String(agreed.current_phase));
  check('which outranks a bare announcement', arrivalFor(agreed).verdict === 'on_time', arrivalFor(agreed).verdict);

  // A 10-K has no items at all — 50% of the corpus.
  const tenK = secEdgarAdapter.normalize(hit([], { form: '10-K', root_forms: ['10-K'] }));
  check('a filing with no items still gets a phase', tenK.current_phase === 'Announcement');
  check('and is still kept', tenK.canonical_name.length > 0);
}

console.log('\nAn earnings release says it is probably not a project');
{
  // 2.02 with nothing substantive: quarterly results that matched the full-text
  // query because results discuss data centres. 9% of the corpus.
  const noise = secEdgarAdapter.normalize(hit(['2.02', '9.01']));
  check('it is flagged for the reader', /Likely a quarterly earnings release/.test(noise.description ?? ''), noise.description);
  check('but NOT discarded — the record exists', noise.canonical_name.length > 0);
  check('and NOT forced cold — it could still announce something', !isColdArrival(noise));

  // 2.02 alongside a real agreement is not noise. Companies do both in one 8-K.
  const both = secEdgarAdapter.normalize(hit(['1.01', '2.02', '9.01']));
  check('earnings PLUS an agreement is not flagged as noise', !/Likely a quarterly earnings/.test(both.description ?? ''), both.description);
  check('and it keeps the stronger phase', both.current_phase === 'Awarded', String(both.current_phase));
  // 7.01/8.01 are substantive too.
  const fd = secEdgarAdapter.normalize(hit(['2.02', '7.01']));
  check('earnings with a Reg FD disclosure is not flagged either', !/Likely a quarterly earnings/.test(fd.description ?? ''));
}

console.log('\nWhat the index does not give is still left empty');
{
  /*
    The full-text index carries filer, location, date and form — not value, not
    schedule. Inventing any of those would be the defect three other adapters in this
    repo were fixed for, so they stay null and the completeness score says so.
  */
  const r = secEdgarAdapter.normalize(hit(['1.01']));
  check('no invented value', r.estimated_value === null);
  check('no invented construction start', r.construction_start_date === null);
  check('no invented completion date', r.estimated_completion_date === null);
  check('the filing date IS recorded', r.announced_date === '2026-08-10', String(r.announced_date));
  check('and the location comes through', r.city === 'Castle Rock' || /Castle Rock/.test(String(r.city)), String(r.city));
  // The phase is our inference, not EDGAR's, so completeness must not claim it.
  check('completeness does not claim a published phase', r.fields_populated.project_phase === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
