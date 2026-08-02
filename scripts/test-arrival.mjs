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

import { arrivalFor } from '../src/lib/arrival.ts';
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
  check('and reports the lead time', a.verdict === 'early' && Math.round(a.leadMonths) === 7, `got ${a.leadMonths}`);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
