/**
 * Live probe of every keyless source.
 *
 *   node --experimental-strip-types --import ./scripts/lib/register-alias.mjs scripts/probe-free-sources.mjs
 *
 * Calls each adapter for real, in dry-run mode, and reports whether it
 * answered, how fast, how many records came back, and whether the first record
 * survives normalization. A source that returns 200 but normalizes to garbage
 * is broken in a way an HTTP check would never catch, so both are tested.
 *
 * Runs sequentially — probing twenty providers in parallel is the fastest way
 * to get rate-limited by all of them at once.
 */

// Imported per-module rather than through adapters/index.ts: the barrel also
// pulls in the keyed adapters, which reach for the Supabase-backed credential
// store and therefore next/headers. The keyless adapters are pure fetch+parse.
import { findATenderAdapter, austenderAdapter, contractsFinderAdapter } from '../src/lib/adapters/ocds.ts';
import { secEdgarAdapter } from '../src/lib/adapters/sec-edgar.ts';
import { tedAdapter } from '../src/lib/adapters/ted.ts';
import { worldBankAdapter } from '../src/lib/adapters/world-bank.ts';
import { usaSpendingAdapter } from '../src/lib/adapters/usaspending.ts';
import { planningIeAdapter } from '../src/lib/adapters/planning-ie.ts';
import { nycPermitsAdapter, chicagoPermitsAdapter } from '../src/lib/adapters/socrata-permits.ts';
import {
  dataCenterDynamicsAdapter,
  dataCenterKnowledgeAdapter,
  semiconductorDigestAdapter,
  electriveAdapter,
  powerTechnologyAdapter,
  nuclearEngineeringAdapter,
  miningComAdapter,
  constructionDiveAdapter,
} from '../src/lib/adapters/rss-news.ts';
import { SOURCE_CATALOG } from '../src/lib/sourceCatalog.ts';

const LIVE_ADAPTERS = {
  'find-a-tender': findATenderAdapter,
  austender: austenderAdapter,
  'contracts-finder': contractsFinderAdapter,
  'sec-edgar': secEdgarAdapter,
  ted: tedAdapter,
  'world-bank': worldBankAdapter,
  usaspending: usaSpendingAdapter,
  'planning-ie': planningIeAdapter,
  'nyc-permits': nycPermitsAdapter,
  'chicago-permits': chicagoPermitsAdapter,
  'data-center-dynamics': dataCenterDynamicsAdapter,
  'data-center-knowledge': dataCenterKnowledgeAdapter,
  'semiconductor-digest': semiconductorDigestAdapter,
  electrive: electriveAdapter,
  'power-technology': powerTechnologyAdapter,
  'nuclear-engineering': nuclearEngineeringAdapter,
  'mining-com': miningComAdapter,
  'construction-dive': constructionDiveAdapter,
};

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const slugs = Object.keys(LIVE_ADAPTERS)
  .filter((s) => only.length === 0 || only.includes(s))
  .sort();

console.log(`Probing ${slugs.length} keyless sources\n`);
const results = [];

for (const slug of slugs) {
  const adapter = LIVE_ADAPTERS[slug];
  const started = Date.now();
  const row = { slug, name: SOURCE_CATALOG.find((c) => c.slug === slug)?.name ?? slug, ok: false, count: 0, ms: 0, note: '' };

  try {
    const raw = await adapter.fetchRawProjects({ dryRun: true, pageSize: 5 });
    row.ms = Date.now() - started;
    row.count = raw.length;

    if (raw.length === 0) {
      // Not a failure on its own: a date-windowed feed can genuinely be empty.
      row.ok = true;
      row.note = 'reachable, 0 records in window';
    } else {
      const rec = adapter.normalize(raw[0]);
      const missing = ['canonical_name', 'source_key', 'source_unique_id', 'record_type', 'bu'].filter(
        (f) => !rec[f]
      );
      row.ok = missing.length === 0;
      row.note = missing.length
        ? `normalize missing: ${missing.join(', ')}`
        : `${rec.record_type}/${rec.bu} · tier ${rec.source_completeness_tier} (${rec.population_percentage}%) · "${String(
            rec.canonical_name
          ).slice(0, 42)}"`;
      row.tier = rec.source_completeness_tier;
      row.pct = rec.population_percentage;
      row.contact = Boolean(rec.contact_name || rec.contact_email);
    }
  } catch (e) {
    row.ms = Date.now() - started;
    row.note = e instanceof Error ? e.message.slice(0, 150) : String(e);
  }

  results.push(row);
  console.log(
    `${row.ok ? 'OK  ' : 'FAIL'} ${slug.padEnd(22)} ${String(row.count).padStart(3)} rec ${String(row.ms).padStart(6)}ms  ${row.note}`
  );
}

const ok = results.filter((r) => r.ok);
const empty = ok.filter((r) => r.count === 0);
console.log(`\n${ok.length}/${results.length} working · ${empty.length} reachable but empty`);

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.slug}: ${f.note}`);
}

const withContact = ok.filter((r) => r.contact);
console.log(`\nSources delivering a contact out of the box: ${withContact.map((r) => r.slug).join(', ') || 'none'}`);
