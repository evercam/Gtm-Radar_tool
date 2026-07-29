/**
 * Schedule building and reading back — against the REAL src/lib/cron.ts.
 *
 * The picker and the scheduler have to agree completely. If buildCron emits
 * something cronMatches rejects, the UI shows a confident schedule that never
 * fires; if parseCron misreads its own output, reopening a saved schedule
 * silently changes it. Both failures are invisible until someone notices the
 * data went stale, so the round-trip is tested in both directions.
 *
 *   node --experimental-transform-types scripts/test-schedule.mjs
 */

import {
  buildCron,
  parseCron,
  cronMatches,
  isValidCron,
  describeCron,
  nextRun,
  DEFAULT_SCHEDULE,
} from '../src/lib/cron.ts';

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const group = (n) => console.log(`\n${n}`);
const parts = (over) => ({ ...DEFAULT_SCHEDULE, ...over });
const utc = (iso) => new Date(iso);

group('Every frequency produces the expression it claims');
check('every 15 minutes', buildCron(parts({ frequency: 'every_15_min' })) === '*/15 * * * *');
check('hourly at :30', buildCron(parts({ frequency: 'hourly', minute: 30 })) === '30 * * * *');
check('daily at 04:00', buildCron(parts({ frequency: 'daily', hour: 4, minute: 0 })) === '0 4 * * *');
check('weekdays at 06:15', buildCron(parts({ frequency: 'weekdays', hour: 6, minute: 15 })) === '15 6 * * 1-5');
check('one chosen day', buildCron(parts({ frequency: 'days', hour: 9, minute: 0, weekdays: [1] })) === '0 9 * * 1');
check(
  'several chosen days',
  buildCron(parts({ frequency: 'days', hour: 9, minute: 0, weekdays: [1, 3, 5] })) === '0 9 * * 1,3,5'
);
check(
  'chosen days are sorted and de-duplicated',
  buildCron(parts({ frequency: 'days', hour: 9, minute: 0, weekdays: [5, 1, 5, 3] })) === '0 9 * * 1,3,5'
);
check(
  'no day chosen falls back to every day rather than an unfireable expression',
  buildCron(parts({ frequency: 'days', hour: 9, minute: 0, weekdays: [] })) === '0 9 * * *'
);
check('custom passes through', buildCron(parts({ frequency: 'custom', expression: '5 2 * * 3' })) === '5 2 * * 3');

group('Everything the picker emits is something the scheduler understands');
for (const f of ['every_15_min', 'hourly', 'daily', 'weekdays', 'days']) {
  const expr = buildCron(parts({ frequency: f, hour: 7, minute: 20, weekdays: [3] }));
  check(`${f}: valid shape`, isValidCron(expr), expr);
  check(`${f}: will fire within a year`, nextRun(expr, utc('2026-07-27T00:00:00Z')) !== null, expr);
}

group('Reopening a saved schedule shows the control that made it');
for (const f of ['every_15_min', 'hourly', 'daily', 'weekdays', 'days']) {
  const original = parts({ frequency: f, hour: 13, minute: 45, weekdays: [5] });
  const expr = buildCron(original);
  const back = parseCron(expr);
  check(`${f}: frequency survives`, back.frequency === f, `got ${back.frequency}`);
  check(`${f}: rebuilds identically`, buildCron(back) === expr, `${buildCron(back)} vs ${expr}`);
}

group('Sunday is 0 and 7, and both must round-trip');
check('dow 0 reads as Sunday', parseCron('0 9 * * 0').weekdays.join() === '0');
check('dow 7 also reads as Sunday', parseCron('0 9 * * 7').weekdays.join() === '0');
check('a Sunday schedule fires on a Sunday', cronMatches('0 9 * * 0', utc('2026-08-02T09:00:00Z')));
check('written as 7 it still fires on Sunday', cronMatches('0 9 * * 7', utc('2026-08-02T09:00:00Z')));
check('it does not fire on Monday', !cronMatches('0 9 * * 0', utc('2026-08-03T09:00:00Z')));

group('Matching fires at the minute, and only then');
check('daily 04:00 fires at 04:00', cronMatches('0 4 * * *', utc('2026-07-27T04:00:00Z')));
check('daily 04:00 is silent at 04:01', !cronMatches('0 4 * * *', utc('2026-07-27T04:01:00Z')));
check('daily 04:00 is silent at 05:00', !cronMatches('0 4 * * *', utc('2026-07-27T05:00:00Z')));
check('*/15 fires at :00', cronMatches('*/15 * * * *', utc('2026-07-27T10:00:00Z')));
check('*/15 fires at :45', cronMatches('*/15 * * * *', utc('2026-07-27T10:45:00Z')));
check('*/15 is silent at :07', !cronMatches('*/15 * * * *', utc('2026-07-27T10:07:00Z')));
check('weekdays fires on a Wednesday', cronMatches('15 6 * * 1-5', utc('2026-07-29T06:15:00Z')));
check('weekdays is silent on a Saturday', !cronMatches('15 6 * * 1-5', utc('2026-08-01T06:15:00Z')));
check('weekdays is silent on a Sunday', !cronMatches('15 6 * * 1-5', utc('2026-08-02T06:15:00Z')));

group('A malformed schedule is rejected, never silently accepted');
check('too few fields', !isValidCron('0 4 * *'));
check('too many fields', !isValidCron('0 4 * * * *'));
check('empty', !isValidCron(''));
check('words', !isValidCron('every day'));
check('a rejected expression never matches', !cronMatches('every day', utc('2026-07-27T04:00:00Z')));
check('a rejected expression has no next run', nextRun('nonsense') === null);
check('an unparseable expression falls back to custom', parseCron('nonsense').frequency === 'custom');

group('Next run');
check(
  'daily 04:00 from 03:00 is the same day',
  nextRun('0 4 * * *', utc('2026-07-27T03:00:00Z'))?.toISOString() === '2026-07-27T04:00:00.000Z'
);
check(
  'daily 04:00 from 05:00 is tomorrow',
  nextRun('0 4 * * *', utc('2026-07-27T05:00:00Z'))?.toISOString() === '2026-07-28T04:00:00.000Z'
);
check(
  'the current minute does not count as next',
  nextRun('0 4 * * *', utc('2026-07-27T04:00:00Z'))?.toISOString() === '2026-07-28T04:00:00.000Z'
);
check(
  'a Monday-only schedule, from a Tuesday, is six days out',
  nextRun('0 9 * * 1', utc('2026-07-28T10:00:00Z'))?.toISOString() === '2026-08-03T09:00:00.000Z'
);

group('Descriptions say what will actually happen');
check('no schedule is described as manual', /only when triggered/.test(describeCron(null)));
check('an invalid one warns it will never run', /never run/.test(describeCron('every day')));
check('daily names the time', describeCron('0 4 * * *') === 'every day at 04:00 UTC');
check('one day is named', describeCron('0 9 * * 1') === 'every Monday at 09:00 UTC');
check(
  'several days read as a sentence',
  describeCron('0 9 * * 1,3,5') === 'every Monday, Wednesday and Friday at 09:00 UTC',
  describeCron('0 9 * * 1,3,5')
);
check('weekdays is spelled out', describeCron('15 6 * * 1-5') === 'Monday to Friday at 06:15 UTC');
check('every 15 minutes', describeCron('*/15 * * * *') === 'every 15 minutes');

group('A multi-day schedule fires on each of its days, and no others');
check('fires on Monday', cronMatches('0 9 * * 1,3,5', utc('2026-08-03T09:00:00Z')));
check('fires on Wednesday', cronMatches('0 9 * * 1,3,5', utc('2026-08-05T09:00:00Z')));
check('fires on Friday', cronMatches('0 9 * * 1,3,5', utc('2026-08-07T09:00:00Z')));
check('silent on Tuesday', !cronMatches('0 9 * * 1,3,5', utc('2026-08-04T09:00:00Z')));
check('silent on Sunday', !cronMatches('0 9 * * 1,3,5', utc('2026-08-02T09:00:00Z')));
check('a chosen-days expression round-trips', buildCron(parseCron('0 9 * * 1,3,5')) === '0 9 * * 1,3,5');
check('the next run of a Mon/Wed/Fri schedule lands on a Wednesday', nextRun('0 9 * * 1,3,5', utc('2026-08-03T10:00:00Z'))?.toISOString() === '2026-08-05T09:00:00.000Z');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
