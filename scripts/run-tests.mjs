/**
 * Runs every scripts/test-*.mjs. This is `npm test`.
 *
 *   node scripts/run-tests.mjs            all of them
 *   node scripts/run-tests.mjs theme nav  only files matching those substrings
 *
 * WHY THIS EXISTS RATHER THAN A CHAIN OF &&
 *
 * The test script used to name all 75 files inline. Two problems, one fatal:
 *
 *   It broke. Windows caps a command line near 8191 characters and the chain had
 *   reached it — `npm test` answered "The command line is too long." and ran
 *   nothing at all. A suite that cannot be invoked is worse than a failing one,
 *   because the exit code is indistinguishable from a tooling hiccup.
 *
 *   It let tests go missing. Thirteen files were written, committed, and never
 *   run again, because adding a file and adding it to the chain are two separate
 *   acts and only the first is obvious. Discovery removes the second act: a file
 *   named test-*.mjs in this directory IS in the suite.
 *
 * Every file gets the type-stripping loader flags, including the handful that
 * previously ran on bare node. The loader only adds `@/` resolution, so passing
 * it to a file that imports nothing from src is inert.
 */

import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/*
  Three tests write to live data, and they do not belong in a default run.

  test-archive and test-export-badge flip apollo_exported_at and
  apollo_export_status on a REAL row in canonical_projects to make a fixture, then
  put it back. test-reveal-cache deletes rows from apollo_reveal_cache, which is
  paid Apollo reveal data — deleting it means buying it again.

  Each restores what it touched, and each restore is one crash, timeout or Ctrl-C
  away from not happening. A lead left marked as exported is not a visible
  failure: it silently drops out of every future export, because that is exactly
  what the flag is for.

  They were unreachable before — never in the chain, and self-skipping without
  credentials — so nothing was at risk. Discovery plus a loaded .env.local made
  them live, which is a hazard this runner introduced and has to own. Opt in
  deliberately:

    ALLOW_LIVE_WRITES=1 npm test
*/
const LIVE_WRITE_TESTS = ['test-archive.mjs', 'test-export-badge.mjs', 'test-reveal-cache.mjs'];
const allowLiveWrites = process.env.ALLOW_LIVE_WRITES === '1';

const filters = process.argv.slice(2);
const all = readdirSync(here)
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .filter((f) => filters.length === 0 || filters.some((s) => f.includes(s)))
  .sort();

// Named, not quietly dropped: a suite that reports 72/72 while holding three
// files back is claiming a coverage it does not have.
const held = allowLiveWrites ? [] : all.filter((f) => LIVE_WRITE_TESTS.includes(f));
const files = all.filter((f) => !held.includes(f));

if (files.length === 0) {
  console.error(filters.length ? `No test file matches ${filters.join(', ')}` : 'No test files found');
  process.exit(1);
}

/*
  .env.local, when it is there.

  Two files — test-mcp and test-phase-parity — had their own npm scripts carrying
  `--env-file` and were therefore absent from the old chain, so discovery picked
  them up and they failed on missing credentials. They are not broken; they read
  live config, and with the env loaded both pass.

  Conditional because node treats a missing --env-file as a fatal error, which
  would take the whole suite down on a fresh clone. Without it those two report
  their own missing-config message like every other credentialed test here.
*/
const envFile = existsSync(join(here, '..', '.env.local')) ? ['--env-file=.env.local'] : [];
if (envFile.length === 0) console.log('No .env.local — tests that read live config will skip.\n');

const NODE_ARGS = [
  ...envFile,
  '--experimental-transform-types',
  '--no-warnings',
  '--import',
  './scripts/lib/register-alias.mjs',
];

/*
  Serial, not parallel.

  Several of these reach the same Supabase project and one another's fixtures;
  running them concurrently traded a slow suite for a flaky one. The whole set is
  a couple of minutes, which is cheaper than a failure nobody trusts.
*/
const failures = [];
for (const f of files) {
  const res = spawnSync(process.execPath, [...NODE_ARGS, join('scripts', f)], {
    stdio: 'inherit',
    // Relative --import path resolves against cwd, so pin it to the repo root
    // rather than wherever the caller happened to be.
    cwd: join(here, '..'),
  });
  if (res.status !== 0) failures.push({ file: f, status: res.status, signal: res.signal });
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${files.length - failures.length}/${files.length} test files passed`);
if (held.length) {
  console.log(`
Held back (writes to live data) — run with ALLOW_LIVE_WRITES=1:`);
  for (const f of held) console.log(`  ${f}`);
}
if (failures.length) {
  // Named, because "npm test failed" after two minutes of scrollback is not a
  // finding — the reader needs the file to re-run.
  console.log('\nFailed:');
  for (const f of failures) {
    console.log(`  ${f.file} (exit ${f.status}${f.signal ? `, signal ${f.signal}` : ''})`);
  }
  console.log(`\nRe-run one with:  node scripts/run-tests.mjs ${failures[0].file.replace(/^test-|\.mjs$/g, '')}`);
}
process.exit(failures.length > 0 ? 1 : 0);
