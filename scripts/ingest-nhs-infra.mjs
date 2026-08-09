#!/usr/bin/env node
/**
 * Pulls NHS / health-body construction and estates contracts into canonical_projects.
 *
 *   # see what would land, write nothing
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/ingest-nhs-infra.mjs --dry
 *
 *   # ingest, default 180-day lookback across both UK publishers
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/ingest-nhs-infra.mjs
 *
 *   --days=N      lookback window (default 180)
 *   --slice=N     days per request window (default 30, see below)
 *   --max=N       raw notices to read per slice (default 4000)
 *   --source=slug just one of find-a-tender / contracts-finder
 *
 * Expect this to take a while, and that is not a bug. Both publishers throttle at
 * 12 requests per 120 seconds, so the adapter paces itself at one page every ten
 * seconds — roughly four minutes per thousand notices read.
 *
 * The window is walked in SLICES because `maxRecords` bounds notices READ, not
 * notices kept, and health estates work is about 0.2% of the stream. Find a Tender
 * alone published over 2,100 notices in June 2026, against a hard ceiling of 40
 * pages per request. One call therefore cannot see a whole year; a month at a time
 * fits inside that ceiling with room to spare.
 *
 * Both publishers are keyless, so this needs no API key — only Supabase, which is
 * why it can run headless. The equivalent through /api/ingest/[source] needs a
 * signed-in admin session; this is the same code path without one, following
 * scripts/ingest-gem-local.mjs.
 *
 * Writes are idempotent. canonical_projects is unique on
 * (source_key, source_unique_id), so re-running updates rather than duplicates —
 * which matters here because a contract notice is republished as it moves from
 * tender to award.
 *
 * The scoping is done by `@/lib/healthInfra`, not by a keyword: NHS is almost
 * always in the BUYER's name and almost never in the title, and the generic
 * construction vocabulary both admits IT contracts and drops asbestos work. See
 * that module, and scripts/test-health-infra.mjs, for why.
 */

import { findATenderAdapter, contractsFinderAdapter } from '@/lib/adapters/ocds';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { sourceProvenance } from '@/lib/provenance';
import { upsertSourceRecords } from '@/lib/sources/upsertRecords';
import { startRun, finishRun } from '@/lib/sources/runs';
import { classifyHealthInfra } from '@/lib/healthInfra';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const only = args.find((a) => a.startsWith('--source='))?.split('=')[1] ?? null;

const days = flag('days', 180);
const slice = flag('slice', 30);
// 40 pages x 100 is the adapter's own ceiling; asking for more cannot read more.
const max = flag('max', 4000);

if (!Number.isFinite(days) || days <= 0) {
  console.error('--days must be a positive number.');
  process.exit(1);
}
if (!isSupabaseServiceConfigured()) {
  console.error('Supabase service role is not configured — run with --env-file=.env.local');
  process.exit(1);
}

const PUBLISHERS = [
  { slug: 'find-a-tender', sourceKey: 'find_a_tender_uk', adapter: findATenderAdapter },
  { slug: 'contracts-finder', sourceKey: 'contracts_finder_uk', adapter: contractsFinderAdapter },
].filter((p) => !only || p.slug === only);

if (PUBLISHERS.length === 0) {
  console.error(`Unknown --source. Use find-a-tender or contracts-finder.`);
  process.exit(1);
}

const since = new Date(Date.now() - days * 86_400_000);
console.log(`${dry ? 'DRY RUN — nothing will be written' : 'Ingesting'}`);
console.log(`window: ${since.toISOString().slice(0, 10)} -> today (${days} days), in ${slice}-day slices`);
console.log(`paced at one page per 10s to stay under the publishers' 12-per-120s throttle\n`);

const supabase = getServiceSupabase();
let grandInserted = 0;
let grandUpdated = 0;
const kept = [];
/** Windows that could not be read at all — reported so a partial sweep is visible. */
const incompleteWindows = [];

for (const { slug, sourceKey, adapter } of PUBLISHERS) {
  const startedAtMs = Date.now();
  console.log(`--- ${slug} ---`);

  // Recorded like any other run, so /control/sources shows this alongside the
  // scheduled pulls rather than the rows appearing from nowhere.
  const runId = dry
    ? null
    : await startRun({
        slug,
        sourceKey,
        trigger: 'backfill',
        params: { healthInfraOnly: true, lookbackDays: days, maxRecords: max, via: 'scripts/ingest-nhs-infra.mjs' },
      });

  /*
    Walk the window a slice at a time.

    Slice size is chosen so a slice fits inside the adapter's 40-page (4,000
    notice) ceiling: the busiest publisher-month observed was Find a Tender's June
    2026 at roughly 2,100 notices. At the default 30 days there is therefore about
    half again in headroom, and nothing is silently cut.

    That is a sizing argument, not a guarantee — the adapter does not report how
    many notices it read, so this cannot DETECT truncation, only make it unlikely.
    Widening --slice past a month is what would put it at risk.
  */
  let fetched = 0;
  let normalizedCount = 0;
  let inserted = 0;
  let updated = 0;
  let collapsed = 0;
  let failed = 0;
  const failedSlices = [];
  let lastError = null;

  /**
   * One slice: fetch, normalize, WRITE.
   *
   * The write is per slice rather than per publisher on purpose. When these were
   * batched to the end, a paced 20-minute sweep that lost its connection on the
   * fourth month discarded the three months it had already collected — the work
   * was done, the records were in memory, and nothing survived the process
   * exiting. Now each month is durable the moment it lands, and a later failure
   * costs only that month.
   */
  const runSlice = async (sliceFrom, sliceTo, label) => {
    // `healthInfraOnly` filters inside the adapter, so `hits` is already scoped;
    // `maxRecords` bounds what was READ to get there.
    const hits = await adapter.fetchRawProjects({
      since: sliceFrom,
      until: sliceTo,
      // The publishers' own maximum. A page of 100 costs the same as a page of 5.
      pageSize: 100,
      maxRecords: max,
      healthInfraOnly: true,
    });
    fetched += hits.length;

    const normalized = [];
    for (const r of hits) {
      try {
        normalized.push(adapter.normalize(r));
      } catch {
        failed += 1;
      }
    }
    normalizedCount += normalized.length;

    // Every populated field on a fresh record came from the publisher.
    for (const n of normalized) n.field_provenance = sourceProvenance(n);

    for (const n of normalized) {
      const why = classifyHealthInfra(n.company_name_raw, `${n.canonical_name} ${n.description ?? ''}`);
      kept.push({
        slug,
        name: n.canonical_name,
        buyer: n.company_name_raw,
        kind: why.workKind,
        value: n.estimated_value,
        currency: n.estimated_value_currency,
        phase: n.current_phase,
        contact: n.contact_email || n.contact_phone || n.contact_name || null,
      });
    }

    if (dry || normalized.length === 0) {
      console.log(`  ${label}  ${String(hits.length).padStart(3)} kept${dry ? '' : ' (nothing to write)'}`);
      return;
    }

    const outcome = await upsertSourceRecords(supabase, sourceKey, normalized);
    inserted += outcome.inserted;
    updated += outcome.updated;
    collapsed += outcome.collapsed;
    grandInserted += outcome.inserted;
    grandUpdated += outcome.updated;
    console.log(
      `  ${label}  ${String(hits.length).padStart(3)} kept -> ${outcome.inserted} new, ${outcome.updated} updated`
    );
  };

  const slices = [];
  for (let offset = 0; offset < days; offset += slice) {
    const sliceTo = new Date(Date.now() - offset * 86_400_000);
    const sliceFrom = new Date(Date.now() - Math.min(days, offset + slice) * 86_400_000);
    slices.push([sliceFrom, sliceTo, `${sliceFrom.toISOString().slice(0, 10)}..${sliceTo.toISOString().slice(0, 10)}`]);
  }

  for (const [sliceFrom, sliceTo, label] of slices) {
    try {
      await runSlice(sliceFrom, sliceTo, label);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.log(`  ${label}  FAILED: ${lastError.slice(0, 120)}`);
      failedSlices.push([sliceFrom, sliceTo, label]);
    }
  }

  /*
    One retry pass for the slices that fell over.

    The observed failures were `TypeError: fetch failed` — a connection dropped,
    not a rejection — and three consecutive months went the same way, which reads
    as a transient network problem rather than the publisher refusing us. A single
    retry is worth it; a retry loop would just hammer a service that is down.
  */
  if (failedSlices.length && !dry) {
    console.log(`  retrying ${failedSlices.length} failed slice(s)...`);
    const stillFailed = [];
    for (const [sliceFrom, sliceTo, label] of failedSlices) {
      try {
        await runSlice(sliceFrom, sliceTo, label);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.log(`  ${label}  FAILED AGAIN: ${lastError.slice(0, 120)}`);
        stillFailed.push(label);
      }
    }
    failedSlices.length = 0;
    failedSlices.push(...stillFailed.map((l) => [null, null, l]));
  }

  const gaps = failedSlices.map((f) => (Array.isArray(f) ? f[2] : f));
  console.log(
    `  ${slug}: ${fetched} kept, ${inserted} new, ${updated} updated, ${collapsed} duplicate, ${failed} unusable`
  );
  if (gaps.length) {
    // Named, not swallowed: these windows were never read, and a total that hides
    // that reads as full coverage.
    console.log(`  INCOMPLETE — ${gaps.length} window(s) could not be read: ${gaps.join(', ')}`);
    incompleteWindows.push(...gaps.map((g) => `${slug} ${g}`));
  }

  if (runId) {
    await finishRun(runId, {
      ok: gaps.length === 0,
      fetched,
      normalized: normalizedCount,
      inserted,
      updated,
      duplicates: collapsed,
      failed,
      error: gaps.length ? `${gaps.length} window(s) unread: ${lastError}` : undefined,
      errorKind: gaps.length ? 'network' : undefined,
      startedAtMs,
    });
  }
  console.log('');
}

const money = (v, c) => (v == null ? '—' : `${c ?? ''}${Number(v).toLocaleString('en-GB')}`);
console.log(`${kept.length} health-infrastructure project(s):\n`);
for (const k of kept) {
  console.log(`  ${(k.kind ?? '?').padEnd(18)} ${money(k.value, k.currency).padStart(14)}  ${k.name.slice(0, 74)}`);
  console.log(`  ${''.padEnd(18)} ${''.padStart(14)}  ${k.buyer ?? 'unknown buyer'}${k.contact ? ` · ${k.contact}` : ' · no contact'}`);
}

console.log(
  `\n${dry ? 'DRY RUN — nothing written.' : `Done. ${grandInserted} inserted, ${grandUpdated} updated.`}`
);
if (!dry && grandInserted + grandUpdated > 0) {
  console.log('They are in canonical_projects now — prioritise and assign them as usual.');
}
