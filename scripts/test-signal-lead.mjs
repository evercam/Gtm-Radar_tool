/**
 * How early a source speaks — the tie-break for the undated majority.
 *
 *   node --experimental-transform-types --import ./scripts/lib/register-alias.mjs \
 *        scripts/test-signal-lead.mjs
 *
 * Making `early` require a date was right, but it collapsed 63% of the book into
 * one `unconfirmed` bucket, and that bucket could not tell these two apart:
 *
 *   an ISSUED Chicago building permit   work starts in weeks
 *   a MISO Phase 1 queue entry          the project does not physically exist yet
 *
 * Measured 2026-08-13: both `unconfirmed`, both warm, ~50,000 permits against
 * 3,728 queue entries competing for the same enrichment spend. Neither record
 * carries a date, so no date can separate them — the publisher is the only thing
 * that knows, which is what `signalLead` writes down.
 */

import { arrivalFor, compareArrival, ARRIVAL_ORDER } from '../src/lib/arrival.ts';
import { SOURCE_CATALOG, SIGNAL_LEAD, signalLeadFor } from '../src/lib/sourceCatalog.ts';

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

console.log('\nEvery catalogued source declares how early it speaks');
{
  const missing = SOURCE_CATALOG.filter((s) => !s.signalLead);
  check(`all ${SOURCE_CATALOG.length} entries assigned`, missing.length === 0, missing.map((s) => s.name).join(', '));
  const orders = Object.values(SIGNAL_LEAD).map((v) => v.order);
  check('every lead has a distinct sort position', new Set(orders).size === orders.length);
  check('every lead has wording for the UI', Object.values(SIGNAL_LEAD).every((v) => v.label.length > 0));
}

console.log('\nThe scale runs earliest to latest');
{
  const o = (l) => SIGNAL_LEAD[l].order;
  check('a grid queue is the earliest thing we get', o('pre_project') < o('planning'));
  check('planning precedes procurement', o('planning') < o('procurement'));
  check('procurement precedes a granted permit', o('procurement') < o('permitted'));
  check('a granted permit is the latest still worth a call', o('permitted') < o('existing'));
  /*
    `announced` sits below procurement on purpose. Press is sometimes the first
    word on a project and sometimes reports a topping-out; an unrankable source
    cannot be ranked highly on the strength of its best case.
  */
  check('press ranks below procurement, being unrankable', o('procurement') < o('announced'));
  check('but still above a granted permit', o('announced') < o('permitted'));
}

console.log('\nAn unknown publisher is not promoted');
{
  // The dangerous default: treating an unrecognised source_key as early would put
  // every unmapped row at the top of the book.
  check('an unmapped source_key falls back to announced', signalLeadFor('who_knows') === 'announced');
  check('so does a null one', signalLeadFor(null) === 'announced');
  check('and it is NOT pre_project', signalLeadFor('who_knows') !== 'pre_project');
}

console.log('\nThe real case: a permit and a grid queue entry, side by side');
{
  // Both shapes are real, taken from the live corpus: chicago permits are 400/400
  // `Issued`, miso is `Phase 1` with no dates at all.
  const permit = arrivalFor({ source_key: 'chicago_building_permits', current_phase: 'Issued', record_type: 'project' });
  const queue = arrivalFor({ source_key: 'miso_interconnection_queue', current_phase: 'Phase 1', record_type: 'project' });

  check('both are still unconfirmed', permit.verdict === 'unconfirmed' && queue.verdict === 'unconfirmed', `${permit.verdict}/${queue.verdict}`);
  check('so ARRIVAL_ORDER alone cannot separate them', ARRIVAL_ORDER[permit.verdict] === ARRIVAL_ORDER[queue.verdict]);
  check('the queue entry sorts FIRST', compareArrival(queue, permit) < 0, `got ${compareArrival(queue, permit)}`);
  check('and the permit sorts after it', compareArrival(permit, queue) > 0);
  check('the permit says it is weeks out', /weeks out/.test(permit.summary), permit.summary);
  check('the queue says the project does not exist yet', /does not exist yet/.test(queue.summary), queue.summary);
}

console.log('\nA whole book sorts earliest-source-first inside unconfirmed');
{
  const of = (key, phase) => arrivalFor({ source_key: key, current_phase: phase, record_type: 'project' });
  const book = [
    of('chicago_building_permits', 'Issued'),
    of('gem_energy_tracker', 'Proposed'),
    of('find_a_tender_uk', 'Tender'),
    of('miso_interconnection_queue', 'Phase 1'),
    of('planning_ie', 'NEW APPLICATION'),
    of('data_center_dynamics', 'Proposed'),
  ].sort(compareArrival);
  const leads = book.map((a) => a.signalLead);
  check(
    'order is pre_project, planning, procurement, announced, permitted, existing',
    JSON.stringify(leads) === JSON.stringify(['pre_project', 'planning', 'procurement', 'announced', 'permitted', 'existing']),
    leads.join(' > ')
  );
}

console.log('\nA DATED verdict is never reordered by its source');
{
  /*
    The inversion this must not cause: a grid-queue entry breaking ground in three
    years outranking a permit breaking ground next month. Once a date exists it
    knows more than the publisher does, so the tie-break stays out of it.
  */
  const NOW = new Date('2026-08-13T00:00:00Z').getTime();
  const M = 30.44 * 86400000;
  const soon = arrivalFor(
    { source_key: 'chicago_building_permits', current_phase: 'Permitting', construction_start_date: new Date(NOW + 2 * M).toISOString() },
    undefined,
    NOW
  );
  const faraway = arrivalFor(
    { source_key: 'miso_interconnection_queue', current_phase: 'Permitting', construction_start_date: new Date(NOW + 36 * M).toISOString() },
    undefined,
    NOW
  );
  check('the permit two months out is early', soon.verdict === 'early', soon.verdict);
  check('the queue entry three years out is too_early', faraway.verdict === 'too_early', faraway.verdict);
  check('and the DATED permit sorts first despite a later source', compareArrival(soon, faraway) < 0);

  // Two early records from different sources must not be reordered at all.
  const alsoSoon = arrivalFor(
    { source_key: 'miso_interconnection_queue', current_phase: 'Permitting', construction_start_date: new Date(NOW + 3 * M).toISOString() },
    undefined,
    NOW
  );
  check('two dated early records tie, source ignored', compareArrival(soon, alsoSoon) === 0, `got ${compareArrival(soon, alsoSoon)}`);
}

console.log('\nsignalLead is always present, whatever the verdict');
{
  for (const phase of ['Operating', 'Under Construction', 'Permitting', null]) {
    const a = arrivalFor({ source_key: 'nyc_dob_permits', current_phase: phase, record_type: 'project' });
    check(`phase ${phase ?? '(null)'} still carries a lead`, typeof a.signalLead === 'string' && a.signalLead.length > 0);
  }
  // Only unconfirmed records get the lead spelled out in the sentence.
  const cold = arrivalFor({ source_key: 'gem_energy_tracker', current_phase: 'Operating' });
  check('a cold record does not advertise its source lead', !/This source speaks/.test(cold.summary), cold.summary);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
