import { NextRequest, NextResponse } from 'next/server';
import { getLiveAdapter, LIVE_SOURCE_SLUGS } from '@/lib/adapters';
import { AdapterAuthError, AdapterNetworkError, AdapterShapeError } from '@/lib/adapters/types';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { sourceProvenance } from '@/lib/provenance';
import { upsertSourceRecords } from '@/lib/sources/upsertRecords';
import { clampRunBudget } from '@/lib/sources/apiLimits';
import { getSourceConfig, canRun, recordRunOutcome } from '@/lib/sources/config';
import { startRun, finishRun } from '@/lib/sources/runs';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
/**
 * A deep pull needs room, and this route had no explicit budget at all — it ran on
 * whatever the platform default happened to be. Measured on NYC permits: fetching
 * 10,000 records takes 5 seconds and writing them takes 81, so the write dominates
 * and the ceiling has to accommodate it.
 *
 * The cron waits on every due source in parallel, so what matters is the SLOWEST
 * single source rather than the total. 300 leaves roughly three times the headroom
 * a 10,000-record run needs.
 */
export const maxDuration = 300;

// Maps the URL slug (barbour-abi, glenigan) to the source_registry.source_key
// (barbour_abi, glenigan) used everywhere else in the schema.
const SOURCE_KEY_BY_SLUG: Record<string, string> = {
  'barbour-abi': 'barbour_abi',
  glenigan: 'glenigan',
  'construct-connect': 'construct_connect',
  'sam-gov': 'sam_gov',
  'sec-edgar': 'sec_edgar',
  'find-a-tender': 'find_a_tender_uk',
  austender: 'austender',
  'contracts-finder': 'contracts_finder_uk',
  'public-contracts-scotland': 'public_contracts_scotland',
  'neso-tec': 'neso_tec_register',
  'neso-embedded': 'neso_embedded_register',
  ted: 'ted',
  'world-bank': 'world_bank',
  usaspending: 'usaspending_gov',
  'planning-ie': 'planning_ie',
  'nyc-permits': 'nyc_dob_permits',
  'chicago-permits': 'chicago_building_permits',
  'calgary-permits': 'calgary_building_permits',
  'data-center-dynamics': 'data_center_dynamics',
  'data-center-knowledge': 'data_center_knowledge',
  'semiconductor-digest': 'semiconductor_digest',
  electrive: 'electrive',
  'power-technology': 'power_technology',
  'nuclear-engineering': 'nuclear_engineering_intl',
  'mining-com': 'mining_com',
  'construction-dive': 'construction_dive',
  gem: 'gem_energy_tracker',
  'news-search': 'news_search',
};

/**
 * POST /api/ingest/[source]
 *
 * `source` must be a slug with a live adapter — anything else 404s.
 *
 * The set is `LIVE_SOURCE_SLUGS`, and is NOT restated here. This comment used to
 * say "only barbour-abi and glenigan, the remaining 63 catalog rows are
 * metadata-only", which was true when written and wrong for a long time
 * afterwards: there are 29 live adapters now. A hand-maintained list of what the
 * code already knows drifts silently, and the 404 it produced sent people looking
 * for a missing adapter that was registered all along.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ source: string }> }) {
  const auth = await checkPermission('sources.ingest');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const { source } = await context.params;
  const adapter = getLiveAdapter(source);

  if (!adapter) {
    return NextResponse.json(
      {
        // Listed from the registry, so this can never disagree with what is
        // actually ingestable.
        error: `Unknown or non-live source "${source}".`,
        liveSources: LIVE_SOURCE_SLUGS,
      },
      { status: 404 }
    );
  }

  if (!(await adapter.isConfigured())) {
    return NextResponse.json(
      {
        configured: false,
        message: 'Add this source’s API key in /admin/settings to enable live ingestion.',
      },
      { status: 200 }
    );
  }

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      {
        configured: false,
        message:
          'Supabase service role is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.',
      },
      { status: 200 }
    );
  }

  // Per-source rails: a disabled source or one over its monthly cap never runs.
  const config = await getSourceConfig(source);
  const gate = canRun(config);
  if (!gate.allowed) {
    return NextResponse.json({ configured: true, message: gate.reason }, { status: 200 });
  }

  const sourceKey = SOURCE_KEY_BY_SLUG[source];
  const supabase = getServiceSupabase();
  const startedAtMs = Date.now();

  let body: {
    since?: string;
    until?: string;
    /** Relative alternative to `since`, so a saved default cannot go stale. */
    lookbackDays?: number;
    pageSize?: number;
    maxRecords?: number;
    minValue?: number;
    keyword?: string;
    postcodes?: string[];
    sectors?: string[];
    regions?: string[];
    verticals?: string[];
    constructionOnly?: boolean;
    healthInfraOnly?: boolean;
    stage?: 'planning' | 'tender' | 'award';
    trigger?: string;
  } = {};
  try {
    body = await request.json();
  } catch {
    // no body sent — fine, ingest with defaults
  }

  // Record what actually triggered the run. This was hardcoded to 'manual',
  // which made the history unable to answer the one question it exists for:
  // did the scheduler run, or has someone been pressing the button?
  const TRIGGERS = ['manual', 'cron', 'backfill'] as const;
  const trigger = (TRIGGERS as readonly string[]).includes(body.trigger ?? '')
    ? (body.trigger as (typeof TRIGGERS)[number])
    : 'manual';

  const runId = await startRun({ slug: source, sourceKey, trigger, triggeredBy: auth.user.id });

  // A scheduled run sends no filters, so the saved query is what it pulls.
  // An explicit body still wins — that is a manual "ingest exactly this".
  const hasExplicitFilters = Object.keys(body).some((k) => k !== 'pageSize' && k !== 'trigger');
  const params = hasExplicitFilters ? body : { ...(config.queryParams as typeof body), ...body };

  let inserted = 0;
  let updated = 0;
  let failed = 0;
  let sample: unknown[] = [];

  try {
    // An explicit `since` wins; `lookbackDays` is resolved against now, so a
    // default written once stays a rolling window rather than an ageing date.
    const since = params.since
      ? new Date(params.since)
      : params.lookbackDays
        ? new Date(Date.now() - params.lookbackDays * 86_400_000)
        : undefined;

    const raw = await adapter.fetchRawProjects({
      since,
      until: params.until ? new Date(params.until) : undefined,
      pageSize: params.pageSize ?? config.pageSize,
      /**
       * The run's budget, at last applied.
       *
       * `max_records_per_run` has been in `source_config` all along, read into
       * the config object, and passed to nothing — so every source fetched one
       * page and stopped. 500 was allowed and 50 taken, at 2-8 requests a month
       * against sources with no cap.
       */
      maxRecords: clampRunBudget(source, params.maxRecords ?? config.maxRecordsPerRun),
      minValue: params.minValue,
      keyword: params.keyword,
      postcodes: params.postcodes,
      sectors: params.sectors,
      regions: params.regions,
      verticals: params.verticals,
      constructionOnly: params.constructionOnly,
      healthInfraOnly: params.healthInfraOnly,
      stage: params.stage,
    });

    const normalized = raw
      .map((r) => {
        try {
          return adapter.normalize(r);
        } catch {
          failed += 1;
          return null;
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // Stamp provenance: every populated field on a fresh record is 'source'.
    for (const n of normalized) n.field_provenance = sourceProvenance(n as unknown as Record<string, unknown>);

    sample = normalized.slice(0, 5);

    if (normalized.length > 0) {
      // One duplicated (source_key, source_unique_id) pair inside a batch makes
      // Postgres reject the ENTIRE upsert — Find a Tender returned the same
      // notice twice and lost its whole scheduled run to it.
      /**
       * One shared writer, chunked on both the write and the existence probe.
       *
       * This block used to do it inline and unchunked, which was survivable at
       * fifty records a run and broke four sources the first morning after the
       * fetch depth went up — all four on "canceling statement due to statement
       * timeout". Every fix it needed already existed in the GEM path.
       */
      const outcome = await upsertSourceRecords(supabase, sourceKey, normalized);
      if (outcome.collapsed > 0) failed += outcome.collapsed;
      inserted = outcome.inserted;
      updated = outcome.updated;
    }

    // Health used to be written to `source_registry`, which was retired with
    // the single-table model — those updates silently no-oped. It now lands on
    // source_config, which the seeding page actually reads.
    await recordRunOutcome(source, { ok: true, durationMs: Date.now() - startedAtMs });
    await finishRun(runId, {
      ok: true,
      fetched: raw.length,
      normalized: normalized.length,
      inserted,
      updated,
      failed,
      startedAtMs,
    });

    return NextResponse.json({ inserted, updated, failed, fetched: raw.length, runId, sample });
  } catch (err) {
    const message = classifyError(err);
    await recordRunOutcome(source, { ok: false, durationMs: Date.now() - startedAtMs, error: message });
    await finishRun(runId, {
      ok: false,
      inserted,
      updated,
      failed,
      error: message,
      errorKind: errorKind(err),
      startedAtMs,
    });

    return NextResponse.json({ error: message, inserted, updated, failed, runId }, { status: 502 });
  }
}

function errorKind(err: unknown): string {
  if (err instanceof AdapterAuthError) return 'auth';
  if (err instanceof AdapterNetworkError) return 'network';
  if (err instanceof AdapterShapeError) return 'shape';
  return 'unknown';
}

function classifyError(err: unknown): string {
  if (err instanceof AdapterAuthError) return `Authentication error: ${err.message}`;
  if (err instanceof AdapterNetworkError) return `Network error: ${err.message}`;
  if (err instanceof AdapterShapeError) return `Unexpected response shape: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
