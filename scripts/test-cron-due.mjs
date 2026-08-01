/**
 * Schedule dueness — against the REAL src/lib/cron.ts.
 *
 * `scripts/test-cron.mjs` carries its own copy of `cronMatches`, so it proves
 * the matcher's arithmetic but never touches the function that decides whether a
 * source runs. That decision is where the bug was: matching the current minute
 * assumes the trigger arrives in the minute the schedule names, and Vercel fired
 * a `0 6 * * *` cron at 06:59 — so every scheduled source was skipped, silently,
 * every day.
 *
 *   node --experimental-transform-types --import ./scripts/lib/register-alias.mjs \
 *     scripts/test-cron-due.mjs
 */

const { isDue, previousRun, nextRun, cronMatches } = await import('../src/lib/cron.ts');

let passed = 0;
let failed = 0;
const t = (name, cond, detail) => {
  if (cond) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

const utc = (iso) => new Date(iso);
const DAILY_6 = '0 6 * * *';

console.log('\nThe bug: a late trigger still catches its occurrence');
{
  // 2026-07-31 is a Friday. Vercel fired at 06:59 for a 06:00 schedule.
  const firedLate = utc('2026-07-31T06:59:17Z');
  t('minute-exact matching misses it — the old behaviour', cronMatches(DAILY_6, firedLate) === false);
  t('but it IS due, never having run', isDue(DAILY_6, null, firedLate) === true);
  t('and due when the last run predates 06:00', isDue(DAILY_6, utc('2026-07-30T06:00:00Z'), firedLate) === true);
}

console.log('\nIt cannot double-run');
{
  const later = utc('2026-07-31T07:30:00Z');
  t('not due once it has run since 06:00', isDue(DAILY_6, utc('2026-07-31T06:00:04Z'), later) === false);
  t('not due if it ran later still', isDue(DAILY_6, utc('2026-07-31T07:00:00Z'), later) === false);
  t('due again the next day', isDue(DAILY_6, utc('2026-07-31T06:05:00Z'), utc('2026-08-01T06:20:00Z')) === true);
}

console.log('\nBefore the first occurrence of the day, yesterday governs');
{
  const early = utc('2026-07-31T05:00:00Z');
  t('ran yesterday at 06:00 — not due yet', isDue(DAILY_6, utc('2026-07-30T06:00:00Z'), early) === false);
  t('has not run since the day before — due', isDue(DAILY_6, utc('2026-07-29T06:00:00Z'), early) === true);
}

console.log('\nA weekday schedule respects its days');
{
  const WEEKDAYS_6 = '0 6 * * 1-5';
  // 2026-08-01 is a Saturday, 2026-08-03 a Monday.
  t('Saturday falls back to Friday’s occurrence', isDue(WEEKDAYS_6, utc('2026-07-31T06:10:00Z'), utc('2026-08-01T09:00:00Z')) === false);
  t('Monday is due again', isDue(WEEKDAYS_6, utc('2026-07-31T06:10:00Z'), utc('2026-08-03T06:40:00Z')) === true);
}

console.log('\npreviousRun mirrors nextRun');
{
  const from = utc('2026-07-31T06:59:00Z');
  const prev = previousRun(DAILY_6, from);
  t('previous occurrence is today at 06:00', prev?.toISOString() === '2026-07-31T06:00:00.000Z', prev?.toISOString());
  const next = nextRun(DAILY_6, from);
  t('next occurrence is tomorrow at 06:00', next?.toISOString() === '2026-08-01T06:00:00.000Z', next?.toISOString());
  t('the matcher agrees with previousRun', cronMatches(DAILY_6, prev) === true);
}

console.log('\nUnschedulable input is never due');
{
  t('no expression', isDue(null, null, utc('2026-07-31T06:59:00Z')) === false);
  t('empty expression', isDue('   ', null, utc('2026-07-31T06:59:00Z')) === false);
  t('malformed expression', isDue('not a cron', null, utc('2026-07-31T06:59:00Z')) === false);
  t('an unparseable last-run date is treated as never run', isDue(DAILY_6, 'yesterday-ish', utc('2026-07-31T06:59:00Z')) === true);
}

console.log('\nEvery-15-minutes still behaves');
{
  const at = utc('2026-07-31T06:07:00Z');
  t('due when the last run was before 06:00', isDue('*/15 * * * *', utc('2026-07-31T05:58:00Z'), at) === true);
  t('not due when it ran at 06:00', isDue('*/15 * * * *', utc('2026-07-31T06:00:30Z'), at) === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
