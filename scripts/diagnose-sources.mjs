#!/usr/bin/env node
/**
 * Calls every live adapter and reports what it actually returns.
 *
 *   npm run diagnose:sources [-- --slug=ted] [--verbose]
 *
 * A source that returns nothing looks identical in the UI whether it is
 * unconfigured, rate-limited, returning a shape we stopped understanding, or
 * simply being asked a question with no answers ("projects in the last 24h").
 * This separates those, because the fix is different for each.
 *
 * Runs with the SAME empty params the Source Hub's Run button sends, so a zero
 * here is a zero a user would see. `--defaults` additionally reports what the
 * adapter would return given a sensible date window, which is how we tell
 * "broken" from "asked badly".
 */

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--slug='))?.split('=')[1];
const verbose = args.includes('--verbose');
const withDefaults = args.includes('--defaults');

const { LIVE_ADAPTERS } = await import('../src/lib/adapters/index.ts');
const { getSourceConfig } = await import('../src/lib/sources/config.ts');

/**
 * The params the ingest route would send for this source: its saved query, or
 * the shipped default. Resolving lookbackDays here is what makes a zero in this
 * report a zero a user would actually see — calling the adapter with `{}`
 * bypasses the config layer and misreports any source that relies on it.
 */
async function configuredParams(slug) {
  try {
    const cfg = await getSourceConfig(slug);
    const q = cfg.queryParams ?? {};
    const { lookbackDays, ...rest } = q;
    return {
      ...rest,
      since: q.since ? new Date(q.since) : lookbackDays ? new Date(Date.now() - lookbackDays * 86_400_000) : undefined,
      until: q.until ? new Date(q.until) : undefined,
      _note: lookbackDays ? `lookback ${lookbackDays}d` : Object.keys(q).length ? 'saved query' : '',
    };
  } catch {
    return { _note: '' };
  }
}

const slugs = only ? [only] : Object.keys(LIVE_ADAPTERS);
const results = [];

/** Classify why a call produced nothing, from the error it threw. */
function classify(err) {
  const m = (err?.message ?? String(err)).toLowerCase();
  if (err?.name === 'AdapterAuthError' || /401|403|unauthor|forbidden|credential|api key/.test(m)) return 'auth';
  if (err?.name === 'AdapterShapeError' || /shape|unexpected|parse|json/.test(m)) return 'shape';
  if (/429|rate|quota|throttl/.test(m)) return 'rate-limit';
  if (err?.name === 'AdapterNetworkError' || /timeout|abort|network|enotfound|econn|fetch failed|socket/.test(m))
    return 'network';
  if (/404|not found/.test(m)) return 'endpoint';
  return 'error';
}

async function attempt(adapter, params) {
  const t = Date.now();
  try {
    const rows = await adapter.fetchRawProjects(params);
    return { ok: true, count: rows.length, ms: Date.now() - t, sample: rows[0] };
  } catch (err) {
    return { ok: false, count: 0, ms: Date.now() - t, kind: classify(err), message: (err?.message ?? String(err)).slice(0, 160) };
  }
}

for (const slug of slugs) {
  const adapter = LIVE_ADAPTERS[slug];
  if (!adapter) {
    console.error(`unknown slug: ${slug}`);
    continue;
  }

  let configured = false;
  try {
    configured = await adapter.isConfigured();
  } catch {
    configured = false;
  }

  // Exactly what the Run button sends today, config defaults included.
  const cfgParams = await configuredParams(slug);
  const { _note, ...runParams } = cfgParams;
  const bare = await attempt(adapter, runParams);

  // A reasonable window, to distinguish "broken" from "asked badly".
  let withWindow = null;
  if (withDefaults) {
    const since = new Date(Date.now() - 90 * 86_400_000);
    withWindow = await attempt(adapter, { since, until: new Date(), pageSize: 25 });
  }

  results.push({ slug, sourceKey: adapter.sourceKey, configured, bare, withWindow });

  const status = !bare.ok ? `${bare.kind.toUpperCase()}` : bare.count > 0 ? 'ok' : 'ZERO';
  const extra = withWindow ? `  window:${withWindow.ok ? withWindow.count : withWindow.kind}` : '';
  console.log(
    `${slug.padEnd(24)} cfg:${configured ? 'y' : 'n'}  ${String(bare.count).padStart(5)}  ${String(bare.ms).padStart(6)}ms  ${status}${extra}${_note ? `  [${_note}]` : ''}`
  );
  if (!bare.ok && verbose) console.log(`   ${bare.message}`);
}

// ---- summary ---------------------------------------------------------------
const zero = results.filter((r) => r.bare.ok && r.bare.count === 0);
const failed = results.filter((r) => !r.bare.ok);
const working = results.filter((r) => r.bare.ok && r.bare.count > 0);

console.log(`\n${working.length} returning rows · ${zero.length} returning zero · ${failed.length} erroring`);

if (failed.length) {
  console.log('\nERRORING — grouped by cause');
  const byKind = new Map();
  for (const r of failed) {
    if (!byKind.has(r.bare.kind)) byKind.set(r.bare.kind, []);
    byKind.get(r.bare.kind).push(r);
  }
  for (const [kind, list] of byKind) {
    console.log(`  ${kind} (${list.length})`);
    for (const r of list) console.log(`     ${r.slug.padEnd(24)} ${r.bare.message}`);
  }
}

if (zero.length) {
  console.log('\nZERO BUT NO ERROR — the call succeeded and had nothing to give');
  for (const r of zero) {
    const w = r.withWindow;
    const verdict = !w ? '' : w.ok && w.count > 0 ? `  <- returns ${w.count} WITH a date window` : '  (still zero with a window)';
    console.log(`     ${r.slug.padEnd(24)}${verdict}`);
  }
}

if (withDefaults) {
  const fixable = results.filter((r) => r.bare.ok && r.bare.count === 0 && r.withWindow?.ok && r.withWindow.count > 0);
  console.log(`\n${fixable.length} source(s) would stop returning zero given a default date window.`);
}

/*
  Records whose source_key nothing declares.

  A catalog entry is what makes a source visible: /sources joins its counts on
  source_key, so rows carrying a key with no entry are unattributable — they
  appear in no total and nobody can tell whether they are current or abandoned.
  project_intelligence sat like that with 179 good records, every one naming a
  contractor.

  Checked here rather than in a test because it needs the database. The pure
  half — catalog against adapters against the slug map — is
  scripts/test-source-registry.mjs.
*/
{
  const { SOURCE_CATALOG } = await import('../src/lib/sourceCatalog.ts');
  const { getSourceStats } = await import('../src/lib/queries.ts');
  const declared = new Set(SOURCE_CATALOG.map((c) => c.sourceKey));
  let stats = {};
  try {
    stats = await getSourceStats();
  } catch {
    stats = {};
  }
  const orphans = Object.entries(stats)
    .filter(([key, s]) => !declared.has(key) && (s?.count ?? 0) > 0)
    .sort((a, b) => b[1].count - a[1].count);

  console.log('');
  if (orphans.length === 0) {
    console.log('Every source_key in the data has a catalog entry.');
  } else {
    console.log(`UNATTRIBUTABLE — ${orphans.length} source_key(s) hold records but appear in no catalog entry:`);
    for (const [key, s] of orphans) {
      console.log(`     ${key.padEnd(28)} ${String(s.count).padStart(7)} rows, last ${String(s.lastIngested ?? 'unknown').slice(0, 10)}`);
    }
    console.log('     Add each to SOURCE_CATALOG, or the rows stay invisible on /sources.');
  }
}
