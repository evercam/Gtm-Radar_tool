/**
 * Cron expression matching.
 *
 * A wrong match here either never fires a job or fires it every minute — both
 * silent until someone notices the data is stale or the API bill is large.
 *
 *   node scripts/test-cron.mjs
 */

function cronMatches(expression, at = new Date()) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const fields = [at.getUTCMinutes(), at.getUTCHours(), at.getUTCDate(), at.getUTCMonth() + 1, at.getUTCDay()];

  return parts.every((part, i) => {
    const value = fields[i];
    if (part === '*') return true;
    return part.split(',').some((token) => {
      if (token.startsWith('*/')) {
        const step = Number(token.slice(2));
        return Number.isFinite(step) && step > 0 && value % step === 0;
      }
      const n = Number(token);
      if (i === 4 && n === 7) return value === 0;
      return Number.isFinite(n) && n === value;
    });
  });
}

// 2026-07-26 is a Sunday (day 0).
const at = (iso) => new Date(iso);
const SUNDAY_0400 = at('2026-07-26T04:00:00Z');
const SUNDAY_0430 = at('2026-07-26T04:30:00Z');
const MONDAY_0400 = at('2026-07-27T04:00:00Z');
const MONDAY_0915 = at('2026-07-27T09:15:00Z');

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  if (cond) {
    pass += 1;
    console.log('  PASS', name);
  } else {
    fail += 1;
    console.log('  FAIL', name);
  }
};

console.log('Exact times');
t('daily 04:00 matches at 04:00', cronMatches('0 4 * * *', SUNDAY_0400));
t('daily 04:00 does not match at 04:30', !cronMatches('0 4 * * *', SUNDAY_0430));
t('daily 04:00 does not match at 09:15', !cronMatches('0 4 * * *', MONDAY_0915));
t('every minute matches always', cronMatches('* * * * *', MONDAY_0915));
t('minute 15 matches 09:15', cronMatches('15 * * * *', MONDAY_0915));

console.log('\nSteps');
t('*/15 matches minute 0', cronMatches('*/15 * * * *', SUNDAY_0400));
t('*/15 matches minute 15', cronMatches('*/15 * * * *', MONDAY_0915));
t('*/15 does not match minute 30 at a different hour rule', cronMatches('*/15 * * * *', SUNDAY_0430));
t('*/20 does not match minute 15', !cronMatches('*/20 * * * *', MONDAY_0915));
t('*/0 is rejected rather than dividing by zero', !cronMatches('*/0 * * * *', MONDAY_0915));

console.log('\nLists');
t('minute list matches a member', cronMatches('0,30 4 * * *', SUNDAY_0400));
t('minute list matches the other member', cronMatches('0,30 4 * * *', SUNDAY_0430));
t('minute list rejects a non-member', !cronMatches('5,35 4 * * *', SUNDAY_0400));

console.log('\nDay of week');
t('Sunday as 0 matches', cronMatches('0 4 * * 0', SUNDAY_0400));
t('Sunday as 7 also matches', cronMatches('0 4 * * 7', SUNDAY_0400));
t('Monday rule does not fire on Sunday', !cronMatches('0 4 * * 1', SUNDAY_0400));
t('Monday rule fires on Monday', cronMatches('0 4 * * 1', MONDAY_0400));
t('weekday list matches', cronMatches('0 4 * * 1,3,5', MONDAY_0400));

console.log('\nMalformed input is never a match');
t('too few fields', !cronMatches('0 4 * *', SUNDAY_0400));
t('too many fields', !cronMatches('0 4 * * * *', SUNDAY_0400));
t('empty string', !cronMatches('', SUNDAY_0400));
t('non-numeric token', !cronMatches('0 4 * * MON', MONDAY_0400));
t('whitespace is tolerated', cronMatches('  0   4  *  *  *  ', SUNDAY_0400));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
