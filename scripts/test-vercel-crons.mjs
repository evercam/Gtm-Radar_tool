/**
 * Every cron in vercel.json must run AT MOST ONCE PER DAY.
 *
 *   node --no-warnings scripts/test-vercel-crons.mjs
 *
 * This account is on the Hobby plan, where a sub-daily cron expression does not
 * merely get ignored — it makes the whole deployment INVALID. Vercel rejects it at
 * configuration validation:
 *
 *   cron_jobs_limits_reached: Hobby accounts are limited to daily cron jobs.
 *   This cron expression (20 * * * *) would run more than once per day.
 *
 * So the failure mode is not "the cron does not fire". It is "nothing deploys at
 * all, and the last good build keeps serving", which looks exactly like a healthy
 * site. It has now happened twice:
 *
 *   2026-08-02  b0dd8bb added `0 * * * *` and `30 * * * *`. Caught the same day,
 *               reverted in 7f057ab — "Record why the hourly schedule cannot live
 *               in vercel.json" — and the reasoning written into
 *               supabase/RUN_THESE.md.
 *   2026-08-12  e8f507e added `20 * * * *` for the cycle job. NOT caught. Every
 *               deployment from then until 2026-08-17 was rejected, so eleven
 *               commits sat unshipped while gtm.evercam.io served 11 August code.
 *               Meanwhile the nightly ingest degraded from ~19,000 rows a day to a
 *               few hundred and the fixes for it could not reach production.
 *
 * The prose in RUN_THESE.md was already there the second time and did not help,
 * because vercel.json is schema-validated and rejects unknown keys — so no comment
 * can sit beside the crons where somebody editing them would read it. A test can.
 *
 * If the plan becomes Pro, delete this file rather than editing the limit: the
 * constraint is a fact about the plan, and a test asserting a limit that no longer
 * applies is worse than no test.
 */

import { readFileSync } from 'node:fs';

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

const cfg = JSON.parse(readFileSync('vercel.json', 'utf8'));
const crons = cfg.crons ?? [];

console.log('\nvercel.json parses and declares its crons');
check('vercel.json is valid JSON', typeof cfg === 'object');
check('at least one cron is declared', crons.length > 0, 'no crons — the pipeline would never run');
// Hobby allows two cron jobs. Exceeding it fails the deployment the same way.
check(`at most 2 crons (Hobby limit) — found ${crons.length}`, crons.length <= 2);

console.log('\nNo cron runs more than once a day');
for (const c of crons) {
  const expr = String(c.schedule ?? '');
  const parts = expr.trim().split(/\s+/);
  check(`${c.path} has a 5-field expression`, parts.length === 5, expr);

  const [minute, hour] = parts;
  /*
    A cron runs more than once a day when its MINUTE or HOUR field is anything
    other than a single fixed value — `*`, a list, a range or a step all multiply
    the daily count. `20 * * * *` is hourly precisely because the hour is `*`.
  */
  const fixed = (f) => /^\d+$/.test(f);
  check(
    `${c.path} pins a single minute (got "${minute}")`,
    fixed(minute),
    'a *, list, range or step in the minute field runs many times an hour'
  );
  check(
    `${c.path} pins a single hour (got "${hour}") — this is the one that broke deploys`,
    fixed(hour),
    `"${expr}" would run more than once per day and Vercel will REJECT THE WHOLE DEPLOYMENT`
  );
}

console.log('\nThe two jobs do not collide');
{
  const times = crons.map((c) => String(c.schedule).trim().split(/\s+/).slice(0, 2).join(' '));
  check('each cron has its own time', new Set(times).size === times.length, times.join(' / '));
}

console.log('\nWhat the daily limit costs is written down, not just endured');
{
  const runThese = readFileSync('supabase/RUN_THESE.md', 'utf8');
  // The escape hatch matters: /api/cron is plan-independent, so any external
  // scheduler carrying CRON_SECRET can drive it as often as wanted.
  check('RUN_THESE.md still explains the external-scheduler route', /CRON_SECRET/.test(runThese));
  check('and names the endpoint to point it at', /api\/cron/.test(runThese));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
