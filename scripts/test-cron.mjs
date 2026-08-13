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

/*
  The ingest concurrency pool.

  `runIngest` used to be `await Promise.all(due.map(...))` — every due source
  upserting into canonical_projects at once. Measured 2026-08-13 from
  `ingestion_runs`, thirteen of twenty-five sources failed on "canceling statement
  due to statement timeout", every failure stamped 06:17: the same instant.
  austender died on "records 0-52 of 52" and electrive on "records 0-30 of 30",
  which is what contention looks like rather than volume.

  A capped pool is easy to get subtly wrong in ways nothing would notice — a
  dropped item just means one source silently never ingests, which is the exact
  class of bug being fixed. So the shape is asserted here: every item runs, each
  runs ONCE, and never more than the cap at a time.

  Mirrors the implementation in src/app/api/cron/route.ts. If that changes, change
  this with it.
*/
console.log('\nThe ingest pool runs every source, once, at most N at a time');
{
  const drain = async (n, cap) => {
    const queue = Array.from({ length: n }, (_, i) => ({ slug: `s${i}` }));
    const results = [];
    let live = 0,
      peak = 0;
    const call = async (slug) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      live -= 1;
      return slug;
    };
    const worker = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        results.push(await call(next.slug));
      }
    };
    await Promise.all(Array.from({ length: Math.min(cap, queue.length) }, worker));
    return { ran: results.length, unique: new Set(results).size, peak };
  };

  for (const n of [0, 1, 2, 3, 25, 100]) {
    const r = await drain(n, 2);
    t(`${String(n).padStart(3)} sources: all ran`, r.ran === n, `ran ${r.ran}`);
    t(`${String(n).padStart(3)} sources: none twice`, r.unique === n, `${r.unique} unique of ${r.ran}`);
    t(`${String(n).padStart(3)} sources: never exceeded 2 at once`, r.peak <= 2, `peaked at ${r.peak}`);
  }
  // Promise.all([]) resolves, but a cap computed as min(2, 0) must not spawn a
  // worker that shifts undefined off an empty queue and calls the API with it.
  t('an empty due-list spawns no workers', (await drain(0, 2)).peak === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
