/**
 * Proves the GEM ingest records its health where the Source Hub reads it.
 *
 * This has to be an integration check rather than a unit test, because the bug
 * it guards was a WRITE THAT SUCCEEDED AND MATCHED NOTHING: the update went to
 * `source_registry` (retired) filtered on `source_key` (not that table's key
 * either, which is `slug`), so PostgREST answered 2xx and GEM sat at
 * "unconfigured" forever. Only reading the row back catches that.
 *
 * Safe to run against a database with real GEM history. It snapshots the
 * `source_config` row and the set of existing `ingestion_runs`, asserts on
 * DELTAS rather than absolute counters, and restores the snapshot on the way
 * out. An earlier version refused to run whenever real history existed, which
 * made it a regression guard that could never guard the regression.
 *
 *   npm run verify:gem
 */

const { processGemFiles } = await import('../src/lib/gem/ingest.ts');
const { getServiceSupabase } = await import('../src/lib/supabase/server.ts');
const { deriveHealth } = await import('../src/lib/sources/config.ts');

const SLUG = 'gem';
const SOURCE_KEY = 'gem_energy_tracker';
const TEST_ID_MARKER = 'PTEST0000000';

let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

const service = getServiceSupabase();

const gemFile = (id, name) =>
  JSON.stringify([
    {
      'GEM plant ID': id,
      'Plant name (English)': name,
      'Owner (English)': 'Verification Fixture Ltd [100%]',
      'Country/area': 'United States',
      'ISO3 code': 'USA',
      'Subnational unit': 'Alabama',
      Region: 'North America',
      Status: 'construction',
      'Primary products': 'ammonia',
    },
  ]);

const config = async () => (await service.from('source_config').select('*').eq('slug', SLUG).maybeSingle()).data;
const runIds = async () =>
  new Set(((await service.from('ingestion_runs').select('id').eq('slug', SLUG)).data ?? []).map((r) => r.id));
const newRuns = async (before) => {
  const { data } = await service
    .from('ingestion_runs')
    .select('id, slug, source_key, status, normalized, inserted, error_kind')
    .eq('slug', SLUG);
  return (data ?? []).filter((r) => !before.has(r.id));
};

// Snapshot. `base` is null on a fresh install and a real row on a live one;
// every counter assertion below is written as a delta so both work.
const base = await config();
const baseRunIds = await runIds();
console.log(base ? `Existing GEM history found (total_runs=${base.total_runs}) — asserting on deltas.` : 'No existing GEM history.');

try {
  console.log('\nA successful run reports healthy');
  const good = await processGemFiles([{ name: 'chemicals.json', text: gemFile(`${TEST_ID_MARKER}01`, 'Fixture Alpha') }]);
  check('records were normalized', good.totals.normalized === 1, JSON.stringify(good.totals));

  let cfg = await config();
  check('a source_config row exists, keyed on the slug', Boolean(cfg), 'absent — the health write missed again');
  check('health is healthy', cfg?.health_status === 'healthy', `got '${cfg?.health_status}'`);
  check('the run was counted', (cfg?.total_runs ?? 0) === (base?.total_runs ?? 0) + 1, `total_runs=${cfg?.total_runs}`);
  check('no new failure recorded', (cfg?.total_failures ?? 0) === (base?.total_failures ?? 0));
  check('consecutive failures are clear', cfg?.consecutive_failures === 0);
  check('last_success_at was stamped', cfg?.last_success_at !== base?.last_success_at);
  check('latency was measured', typeof cfg?.avg_latency_ms === 'number');

  let mine = await newRuns(baseRunIds);
  check('an ingestion_runs row was opened and closed', mine.length === 1, `${mine.length} new rows`);
  check('it completed', mine[0]?.status === 'completed', `status=${mine[0]?.status}`);
  check('it carries the canonical source_key too', mine[0]?.source_key === SOURCE_KEY);
  check('it recorded what was normalized', mine[0]?.normalized === 1);

  console.log('\nA run that normalizes nothing reports a failure');
  // Valid JSON, valid array, no recognisable record — parses, yields nothing.
  // The old code could not report this path at all.
  const bad = await processGemFiles([{ name: 'empty.json', text: '[]' }]);
  check('nothing was normalized', bad.totals.normalized === 0);
  check('the caller still sees ok — one bad file never fails the batch', bad.ok === true);

  cfg = await config();
  check('the failure was counted', (cfg?.total_failures ?? 0) === (base?.total_failures ?? 0) + 1, `total_failures=${cfg?.total_failures}`);
  check('consecutive failures incremented', cfg?.consecutive_failures === 1, `got ${cfg?.consecutive_failures}`);
  check('an error message was stored', Boolean(cfg?.last_error), 'no last_error — the Hub would show a blank reason');
  check(
    'health degraded rather than flipping straight to failing',
    cfg?.health_status === 'degraded',
    `got '${cfg?.health_status}'`
  );

  mine = await newRuns(baseRunIds);
  const failedRun = mine.find((r) => r.status === 'failed');
  check('the failed run is in the history', Boolean(failedRun));
  check('classified as a shape problem', failedRun?.error_kind === 'shape', `got '${failedRun?.error_kind}'`);

  console.log('\nA partial batch is not reported as a clean success');
  const partial = await processGemFiles([
    { name: 'chemicals.json', text: gemFile(`${TEST_ID_MARKER}02`, 'Fixture Beta') },
    { name: 'broken.json', text: '{not json' },
  ]);
  check('the good file still persisted', partial.totals.normalized === 1, JSON.stringify(partial.totals));
  cfg = await config();
  check(
    'one file failing marks the run unhealthy',
    cfg?.health_status !== 'healthy',
    `health is '${cfg?.health_status}' despite a file error`
  );
  check('the failing filename is in last_error', /broken\.json/.test(cfg?.last_error ?? ''), cfg?.last_error ?? 'empty');

  console.log('\nA clean run clears the consecutive-failure count');
  await processGemFiles([{ name: 'chemicals.json', text: gemFile(`${TEST_ID_MARKER}03`, 'Fixture Gamma') }]);
  cfg = await config();
  check('consecutive failures reset to 0', cfg?.consecutive_failures === 0, `got ${cfg?.consecutive_failures}`);
  check('total failures retained as history', (cfg?.total_failures ?? 0) === (base?.total_failures ?? 0) + 2);

  check('it is no longer failing', cfg?.health_status !== 'failing', `got '${cfg?.health_status}'`);

  // The stored status must agree with the rule, given the stored counters.
  // Asserting a literal 'degraded' here was wrong: whether the rolling error
  // rate clears 25% depends on how many real runs the install already had, so
  // the expected value moved the moment the folder was re-ingested. What is
  // actually worth guarding is that `health_status` is a faithful projection of
  // the counters — it is persisted, not recomputed on read, so it can drift.
  const expected = deriveHealth({
    isEnabled: cfg?.is_enabled ?? true,
    consecutiveFailures: cfg?.consecutive_failures ?? 0,
    totalRuns: cfg?.total_runs ?? 0,
    totalFailures: cfg?.total_failures ?? 0,
    lastSuccessAt: cfg?.last_success_at ?? null,
  });
  check(
    `stored health matches the rule for ${cfg?.total_failures}/${cfg?.total_runs} runs`,
    cfg?.health_status === expected,
    `stored '${cfg?.health_status}', rule says '${expected}'`
  );

  console.log('\nDuplicate ids in one batch do not abort the upsert');
  // Postgres rejects an ON CONFLICT batch naming the same target twice. GEM
  // publishes at unit grain, so this is the shape of 11 of the 18 real files.
  const dup = await processGemFiles([
    {
      name: 'chemicals.json',
      text: JSON.stringify([
        JSON.parse(gemFile(`${TEST_ID_MARKER}04`, 'Fixture Delta'))[0],
        JSON.parse(gemFile(`${TEST_ID_MARKER}04`, 'Fixture Delta II'))[0],
      ]),
    },
  ]);
  check('the batch survived', !dup.files[0]?.error, dup.files[0]?.error);
  check('both rows normalized', dup.files[0]?.normalized === 2);
  check('the duplicate was collapsed and reported', dup.files[0]?.collapsed === 1, `collapsed=${dup.files[0]?.collapsed}`);
} finally {
  console.log('\nCleaning up');

  // Pattern-matched, not by bare id: the normalizer prefixes the tracker onto
  // source_unique_id (`chemicals:PTEST...`), so an `in(ids)` delete matches
  // nothing and reports success anyway — the same silently-matched-nothing
  // failure this script exists to catch.
  const rows = await service
    .from('canonical_projects')
    .delete()
    .eq('source_key', SOURCE_KEY)
    .like('source_unique_id', `%${TEST_ID_MARKER}%`);
  console.log(rows.error ? `  FAILED to clean canonical_projects: ${rows.error.message}` : '  removed fixture leads');

  const mine = await newRuns(baseRunIds);
  if (mine.length) {
    const del = await service
      .from('ingestion_runs')
      .delete()
      .in('id', mine.map((r) => r.id));
    console.log(del.error ? `  FAILED to clean ingestion_runs: ${del.error.message}` : `  removed ${mine.length} test run(s)`);
  }

  if (base) {
    const { error } = await service.from('source_config').update(base).eq('slug', SLUG);
    console.log(error ? `  FAILED to restore source_config: ${error.message}` : '  restored source_config to its snapshot');
  } else {
    const { error } = await service.from('source_config').delete().eq('slug', SLUG);
    console.log(error ? `  FAILED to remove source_config: ${error.message}` : '  removed the source_config row it created');
  }

  // Never trust a delete's own report — read it back.
  const leftover = await service
    .from('canonical_projects')
    .select('source_unique_id')
    .eq('source_key', SOURCE_KEY)
    .like('source_unique_id', `%${TEST_ID_MARKER}%`);
  if (leftover.data?.length) {
    console.log(`  WARNING ${leftover.data.length} fixture row(s) still present:`);
    for (const r of leftover.data) console.log(`    ${r.source_unique_id}`);
    failed += 1;
  } else {
    console.log('  verified: no fixture rows remain');
  }

  const after = await config();
  if (base && after?.total_runs !== base.total_runs) {
    console.log(`  WARNING source_config not fully restored (total_runs ${base.total_runs} → ${after?.total_runs}).`);
    failed += 1;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
// exitCode rather than process.exit(): an abrupt exit with the Postgres socket
// still open trips a libuv assertion on Windows.
process.exitCode = failed ? 1 : 0;
