/**
 * How early are we arriving — and does the record admit how it knows?
 *
 *   node --experimental-transform-types --import ./scripts/lib/register-alias.mjs \
 *        scripts/test-arrival.mjs
 *
 * The verdict matters less than the BASIS. Measured over the corpus, only 11% of
 * in-scope records carry a construction start date while 66% carry nothing better
 * than an announcement date. A tool that reports both as "arriving early" is
 * asserting something it cannot know, and this codebase has already been bitten
 * twice by that shape — an obfuscated name beside a real email, and "0 revealed"
 * covering four different causes.
 */

import { arrivalFor, isColdArrival, COLD_ARRIVALS, EARLY_WINDOW_MONTHS, LATE_WINDOW_MONTHS, ARRIVAL_ORDER } from '../src/lib/arrival.ts';
import { phaseTiming } from '../src/lib/priority.ts';

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

const NOW = new Date('2026-08-02T00:00:00Z').getTime();
const inMonths = (n) => new Date(NOW + n * 30.44 * 86_400_000).toISOString();
const at = (rec) => arrivalFor(rec, undefined, NOW);

console.log('\nThe strongest basis wins, and is named');
{
  const a = at({
    current_phase: 'Pre-Construction',
    construction_start_date: inMonths(7),
    estimated_completion_date: inMonths(31),
    announced_date: inMonths(-4),
  });
  check('a start date beats the weaker dates', a.basis === 'construction_start', `got ${a.basis}`);
  // 7 months out is now OUTSIDE the 6-month window — real, but not yet callable.
  check('and reports the lead time', a.verdict === 'too_early' && Math.round(a.leadMonths) === 7, `got ${a.verdict}/${a.leadMonths}`);
  check('marked as dated', a.dated === true);
}

console.log('\nA weaker basis says so, out loud');
{
  const a = at({ current_phase: 'Pre-Construction', announced_date: inMonths(-3) });
  check('falls back to the announcement', a.basis === 'announced');
  check('and admits the verdict is inferred', /inferred from the phase/.test(a.summary), a.summary);
  // The trap: 3 months since announcement is NOT 3 months of lead time.
  check('does not claim to be lead time', !/before ground/.test(a.summary), a.summary);
}
{
  const a = at({ current_phase: 'Permitting' });
  check('phase alone is labelled phase_only', a.basis === 'phase_only');
  check('and says no dates were published', /no dates published/.test(a.summary), a.summary);
  check('not marked as dated', a.dated === false);
}

console.log('\nFinished or dead settles it, whatever the dates say');
{
  // A future completion date on an operating plant is a refurbishment, not a build.
  const a = at({ current_phase: 'Operating', estimated_completion_date: inMonths(18) });
  check('operating is too late despite a future date', a.verdict === 'too_late', `got ${a.verdict}`);
}
for (const phase of ['Cancelled', 'Retired', 'Closed', 'Idled', 'Commissioning']) {
  const a = at({ current_phase: phase });
  check(`${phase} is too late`, a.verdict === 'too_late', `got ${a.verdict}`);
}

console.log('\nThe 679 records that used to fall through');
// Every one of these carried a phase the table did not match, so it took the
// record-type default of 0.4 — a middle score for things that are often dead.
for (const phase of [
  'Proposed', 'Announcement', 'IN PROCESS', 'Issued', 'Commissioning', 'PRE_VALIDATION',
  'Discovered', 'Active', 'NEW APPLICATION', 'In-Development', 'Pipeline', 'Closed',
  'On Hold', 'Officer Allocation', 'Idle', 'Valid', 'AI Received', 'Idled',
]) {
  const { label } = phaseTiming(phase, 'project');
  check(`"${phase}" is recognised`, label !== null, 'still falling through to the record-type default');
}

console.log('\nA company record has no arrival, and says why');
{
  const a = at({ record_type: 'account', current_phase: null });
  check('verdict is unknown', a.verdict === 'unknown');
  check('and it explains that no project is attached', /no project attached/.test(a.summary), a.summary);
}

console.log('\nNothing at all is reported as nothing, not guessed');
{
  const a = at({ record_type: 'project', current_phase: null });
  check('unknown, basis none', a.verdict === 'unknown' && a.basis === 'none');
}

console.log('\nBuild remaining is not lead time');
{
  const a = at({ current_phase: 'Construction', estimated_completion_date: inMonths(3) });
  check('three months left is late, not early', a.verdict === 'late', `got ${a.verdict}`);
  const b = at({ current_phase: 'Construction', estimated_completion_date: inMonths(-2) });
  check('a passed completion date is too late', b.verdict === 'too_late', `got ${b.verdict}`);
}

console.log('\nThe phase overrules a date that contradicts it');
{
  // The reported bug, exactly: Atlantic Shores Offshore Wind North sat at
  // Pre-Construction with a completion date five months out and was reported as
  // "Late — only 5 months of build left". You cannot have build left before
  // building starts. 257 records read that way.
  const a = at({ current_phase: 'Pre-Construction', estimated_completion_date: inMonths(5) });
  check('a completion date before work starts is a TARGET, not build left', a.verdict !== 'late', `got ${a.verdict}`);
  check('and the summary says so', /target rather than time remaining/.test(a.summary), a.summary);
  check('the verdict follows the phase', a.verdict === 'on_time', `got ${a.verdict}`);
}
{
  // "Awarded — ground was broken 7 years ago" was real. One of the two is wrong,
  // and the curated phase is a better witness than a date that may be a year
  // bucket or belong to an earlier scheme.
  const a = at({ current_phase: 'Awarded', construction_start_date: inMonths(-84) });
  check('a stale start date does not claim work began', !/ground was broken/.test(a.summary), a.summary);
  check('the conflict is reported rather than hidden', /contradicts/.test(a.summary), a.summary);
  check('and it is not passed off as dated', a.dated === false);
}
{
  // Once building HAS started, a past start date means what it says.
  const a = at({ current_phase: 'Under Construction', construction_start_date: inMonths(-6) });
  check('a started phase still reports elapsed build', /ground was broken/.test(a.summary), a.summary);
  // Ground broken 6 months ago is past the 3-month late window.
  check('and that is too late', a.verdict === 'too_late', `got ${a.verdict}`);
}

console.log('\nAn announcement dated in the future has not happened');
{
  // 652 records carry one, because sources publish a year and the adapter stores
  // 1 January of it. Math.abs turned "five months away" into "announced five
  // months ago" — confidently backwards.
  const a = at({ current_phase: 'Pre-Construction', announced_date: inMonths(5) });
  check('it is not reported as an announcement in the past', !/ago/.test(a.summary), a.summary);
  check('it falls through to the phase', a.basis === 'phase_only', `got ${a.basis}`);
}
{
  const a = at({ current_phase: 'Pre-Construction', announced_date: inMonths(-5) });
  check('a genuine past announcement still reads as one', /ago/.test(a.summary) && a.basis === 'announced', a.summary);
}

console.log('\nCold arrivals are neither enriched nor exported');
{
  /*
    A business decision recorded as a test. `late` still MEANS "mid-build,
    sellable, but the easy win is gone" — the chip keeps saying that. What this
    fixes is what we spend on it, and the three call sites that must agree:
    enrichment queue, assignment, export. If they disagree, enrichment buys a
    contact the export then refuses to send.
  */
  check('late is cold', COLD_ARRIVALS.includes('late'));
  check('too_late is cold', COLD_ARRIVALS.includes('too_late'));
  check('and nothing else is', COLD_ARRIVALS.length === 2, COLD_ARRIVALS.join(','));

  // Built or dead settles it on the phase alone, with no dates at all.
  check('an operating plant is cold', isColdArrival({ current_phase: 'Operating' }));
  check('a cancelled project is cold', isColdArrival({ current_phase: 'Cancelled' }));

  // The window Evercam wants is not cold.
  const soon = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
  check('a project months from breaking ground is not cold', !isColdArrival({ current_phase: 'Awarded', construction_start_date: soon }));

  /*
    `unknown` must NOT be cold. An undated record with no phase has not been
    judged, and treating unjudged as cold would silently drop everything a source
    ships without dates — measured at 150 of 855 assignable leads.
  */
  check('an unjudged record is not cold', !isColdArrival({}), arrivalFor({}).verdict);
  check('and a company record is not cold', !isColdArrival({ record_type: 'account' }), arrivalFor({ record_type: 'account' }).verdict);
}

console.log('\nThe selling window: 6 months before ground-breaking');
{
  /*
    Set by the team on 2026-08-13 and asserted here because it is the single
    criterion this book is ranked on. Before this, "early" meant any future date at
    all — a project breaking ground in 2031 read the same as one starting in March.
  */
  check('the window is 6 months', EARLY_WINDOW_MONTHS === 6);
  check('and late runs 3 months past the start', LATE_WINDOW_MONTHS === 3);

  const v = (m) => at({ current_phase: 'Pre-Construction', construction_start_date: inMonths(m) }).verdict;
  check('24 months out is too early', v(24) === 'too_early', v(24));
  check('7 months out is too early', v(7) === 'too_early', v(7));
  check('5 months out is EARLY — the window', v(5) === 'early', v(5));
  check('1 month out is early', v(1) === 'early', v(1));

  // Past the start date the phase has to agree that work began, or arrivalFor
  // treats the date as stale and keeps the phase's word instead.
  const started = (m) => at({ current_phase: 'Under Construction', construction_start_date: inMonths(m) }).verdict;
  check('started 1 month ago is late', started(-1) === 'late', started(-1));
  check('started 2 months ago is still late', started(-2) === 'late', started(-2));
  check('started 5 months ago is too late', started(-5) === 'too_late', started(-5));

  /*
    too_early must NOT be cold. It is a real project that will enter the window,
    and dropping it would mean never calling anything found more than six months
    ahead — which is most of what an interconnection queue or a planning portal
    surfaces.
  */
  check('too_early is not cold', !COLD_ARRIVALS.includes('too_early'), COLD_ARRIVALS.join(','));
  check('and sorts above late, because it comes back', ARRIVAL_ORDER.too_early < ARRIVAL_ORDER.late);
}

console.log('\n"early" requires a date — the phase alone cannot earn it');
{
  /*
    The rule stated on 2026-08-13: only tell us about a project when the
    information arrived EARLY. The blocker was that `early` did not mean early —
    four paths returned it with no start date at all, gated only on the phase
    weight. Only 11% of records carry a start date, so the 79%-early book was
    mostly this assumption repeated. `early` is now a claim a date has to support.
  */
  for (const phase of ['Permitting', 'Planning', 'Proposed', 'Design', 'Pipeline', 'In-Development']) {
    const a = at({ current_phase: phase, record_type: 'project' });
    check(`"${phase}" alone is unconfirmed, not early`, a.verdict === 'unconfirmed', `got ${a.verdict}`);
    check(`  and does not claim to be dated`, a.dated === false);
  }

  // The weaker dates do not earn it either — neither says when ground breaks.
  const target = at({ current_phase: 'Permitting', estimated_completion_date: inMonths(24) });
  check('a completion target does not earn early', target.verdict === 'unconfirmed', `got ${target.verdict}`);
  const announced = at({ current_phase: 'Planning', announced_date: inMonths(-3) });
  check('an announcement date does not earn early', announced.verdict === 'unconfirmed', `got ${announced.verdict}`);

  // A real start date inside the window still does, and is the ONLY way to.
  check('a start date inside the window is early', at({ current_phase: 'Permitting', construction_start_date: inMonths(4) }).verdict === 'early');

  /*
    unconfirmed must NOT be cold. It is where most of the book now sits, and
    marking it cold would stop enrichment on the majority of records — a far
    bigger decision than making `early` honest.
  */
  check('unconfirmed is not cold', !isColdArrival({ current_phase: 'Permitting' }), COLD_ARRIVALS.join(','));
  check('it outranks too_early, because it might be in the window', ARRIVAL_ORDER.unconfirmed < ARRIVAL_ORDER.too_early);
  check('but never outranks a verified early', ARRIVAL_ORDER.early < ARRIVAL_ORDER.unconfirmed);
}

console.log('\nA started phase with no date is late, not "just started"');
{
  /*
    `Under Construction` with no dates returned `on_time` — "mobilising or just
    started". Nothing on the record says whether ground broke last month or in
    2019, and `on_time` is not cold, so the guess in the expensive direction got
    the record enriched and sold. It is `late`: behind the work, distance unknown.
  */
  for (const phase of ['Under Construction', 'Construction', 'On Site']) {
    const a = at({ current_phase: phase, record_type: 'project' });
    check(`"${phase}" with no date is late`, a.verdict === 'late', `got ${a.verdict}`);
    check(`  so nothing is spent on it`, isColdArrival({ current_phase: phase }));
  }

  // A not-yet-started phase at the top of the table keeps on_time — that is the
  // table making a positive statement, not an absence of one.
  check('pre-construction still reads on_time', at({ current_phase: 'Pre-Construction' }).verdict === 'on_time');
  check('and awarded still reads on_time', at({ current_phase: 'Awarded' }).verdict === 'on_time');
  check('neither is cold', !isColdArrival({ current_phase: 'Pre-Construction' }) && !isColdArrival({ current_phase: 'Awarded' }));
}

console.log('\n"Stage unknown" is an absence, not a death');
{
  /*
    `discovered` sat on weight 0.15 — exactly arrival.ts's DEAD_BELOW, which
    compares with `<=`. So "newly discovered — stage unknown" was judged
    `too_late`, `too_late` is cold, and the EARLIEST signal this tool can receive
    was excluded from enrichment and the Apollo export. The label says unknown.
  */
  const a = at({ current_phase: 'Discovered', record_type: 'project' });
  check('a newly discovered project is not too_late', a.verdict !== 'too_late', `got ${a.verdict}`);
  check('it is unconfirmed — stage unknown, said plainly', a.verdict === 'unconfirmed', `got ${a.verdict}`);
  check('and it is NOT cold', !isColdArrival({ current_phase: 'Discovered' }));

  // The phases that genuinely are over stay on the floor.
  check('commissioning is still too_late', at({ current_phase: 'Commissioning' }).verdict === 'too_late');
  check('and on hold is still too_late', at({ current_phase: 'On Hold' }).verdict === 'too_late');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
