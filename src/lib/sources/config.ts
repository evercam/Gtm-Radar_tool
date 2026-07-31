import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { SOURCE_SLUGS } from '@/lib/sourceSlugs';
import { SOURCE_CATALOG } from '@/lib/sourceCatalog';

/**
 * Configuration reads go through the service role, not the caller's session.
 *
 * These tables are not scoped to a person — their policies say "any signed-in
 * user may read", and the pages that render them are permission-gated already.
 * Routing them through the request client made them depend on a PostgREST
 * token this app can no longer mint, so they silently returned nothing: a
 * roster entry would save correctly and then not appear.
 *
 * `canonical_projects` is deliberately NOT in this group. That data IS scoped
 * per user, and it waits for the direct-Postgres path in lib/db/pool.ts rather
 * than being widened to the service role.
 */
const configReader = () => getServiceSupabase();

/**
 * Per-source ingestion configuration and health.
 *
 * Every adapter gets a config row on demand: a source that has never been
 * configured reads as the defaults below rather than as "missing", so the
 * seeding page can list all 23 whether or not anyone has touched them.
 *
 * Health is rolling state written by each run — it is derived from what
 * actually happened, never set by hand.
 */

export type IngestMode = 'cron' | 'manual' | 'realtime';
export type HealthStatus = 'healthy' | 'degraded' | 'failing' | 'disabled' | 'unconfigured';
export type DedupeStrategy = 'source_id' | 'name_location' | 'domain' | 'email';

export interface SourceConfig {
  slug: string;
  isEnabled: boolean;
  ingestMode: IngestMode;
  scheduleCron: string | null;
  timezone: string;
  monthlyRequestCap: number | null;
  requestsThisMonth: number;
  pageSize: number;
  maxRecordsPerRun: number;
  timeoutMs: number;
  rateLimitPerMinute: number | null;
  dedupeStrategy: DedupeStrategy;
  /** Filter payload a scheduled ingest runs — saved from the search panel. */
  queryParams: Record<string, unknown>;
  querySavedAt: string | null;

  /**
   * Per-source enrichment overrides. Null means "use the global policy" — a
   * source nobody has touched behaves exactly as it did, and turning one
   * engine off for one feed does not require restating everything else.
   */
  enrichClaude: boolean | null;
  enrichApollo: boolean | null;
  enrichFillCommittee: boolean | null;
  maxApolloCallsPerRecord: number | null;
  maxClaudeCallsPerRecord: number | null;

  healthStatus: HealthStatus;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  avgLatencyMs: number | null;
  totalRuns: number;
  totalFailures: number;
}

/** Daily at 04:00 — before the 06:00 prioritisation job reads what was ingested. */
export const DEFAULT_SCHEDULE = '0 4 * * *';

/**
 * Per-source default query, used until someone saves one from the Source Hub.
 *
 * A source that returns nothing because it was asked a question with no answer
 * is indistinguishable, in the UI, from one that is broken. These defaults exist
 * so the Run button produces rows on a fresh install instead of a zero that
 * looks like a fault.
 *
 * `lookbackDays` is relative on purpose. An absolute `since` would be correct on
 * the day it was written and quietly wrong forever after.
 *
 * Deliberately sparse. Most adapters return plenty with no filter at all, and a
 * blanket date window would make things WORSE — measured with
 * `npm run diagnose:sources --defaults`, a 90-day window takes nyc-permits from
 * 100 rows to 0 and nuclear-engineering from 10 to 0, because their date fields
 * are not the ones a recency filter assumes. Add an entry only where a zero was
 * actually observed.
 */
export const SOURCE_DEFAULT_QUERY: Record<string, Record<string, unknown>> = {
  // Glenigan's /project/newproject is a NEW/updated-project event feed, and this
  // subscription's events are historic: measured 2026-07-31, the account returns
  // 0 projects for any window inside a year, 438 over three years and 5,071 over
  // six. The adapter's own 180-day fallback therefore returned nothing at all,
  // with a clean HTTP 200 and no error to explain it.
  glenigan: { lookbackDays: 2190 },
};

export function defaultConfig(slug: string): SourceConfig {
  return {
    slug,
    isEnabled: true,
    ingestMode: 'cron',
    scheduleCron: DEFAULT_SCHEDULE,
    timezone: 'UTC',
    monthlyRequestCap: null,
    requestsThisMonth: 0,
    pageSize: 50,
    maxRecordsPerRun: 500,
    timeoutMs: 30_000,
    rateLimitPerMinute: null,
    dedupeStrategy: 'source_id',
    queryParams: SOURCE_DEFAULT_QUERY[slug] ?? {},
    querySavedAt: null,
    enrichClaude: null,
    enrichApollo: null,
    enrichFillCommittee: null,
    maxApolloCallsPerRecord: null,
    maxClaudeCallsPerRecord: null,
    healthStatus: 'unconfigured',
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    consecutiveFailures: 0,
    avgLatencyMs: null,
    totalRuns: 0,
    totalFailures: 0,
  };
}

function fromRow(r: Record<string, unknown>): SourceConfig {
  const base = defaultConfig(r.slug as string);
  return {
    ...base,
    isEnabled: (r.is_enabled as boolean) ?? base.isEnabled,
    ingestMode: (r.ingest_mode as IngestMode) ?? base.ingestMode,
    scheduleCron: (r.schedule_cron as string) ?? base.scheduleCron,
    timezone: (r.timezone as string) ?? base.timezone,
    monthlyRequestCap: (r.monthly_request_cap as number) ?? null,
    requestsThisMonth: (r.requests_this_month as number) ?? 0,
    pageSize: (r.page_size as number) ?? base.pageSize,
    maxRecordsPerRun: (r.max_records_per_run as number) ?? base.maxRecordsPerRun,
    timeoutMs: (r.timeout_ms as number) ?? base.timeoutMs,
    rateLimitPerMinute: (r.rate_limit_per_minute as number) ?? null,
    dedupeStrategy: (r.dedupe_strategy as DedupeStrategy) ?? base.dedupeStrategy,
    // A query saved from the hub always wins, including one deliberately saved
    // empty — `query_saved_at` is what distinguishes that from never touched.
    // Only an untouched source falls back to the shipped default.
    queryParams: r.query_saved_at
      ? ((r.query_params as Record<string, unknown>) ?? {})
      : ((r.query_params as Record<string, unknown> | null) &&
          Object.keys(r.query_params as Record<string, unknown>).length > 0
          ? (r.query_params as Record<string, unknown>)
          : base.queryParams),
    enrichClaude: (r.enrich_claude as boolean | null) ?? null,
    enrichApollo: (r.enrich_apollo as boolean | null) ?? null,
    enrichFillCommittee: (r.enrich_fill_committee as boolean | null) ?? null,
    maxApolloCallsPerRecord: (r.max_apollo_calls_per_record as number | null) ?? null,
    maxClaudeCallsPerRecord: (r.max_claude_calls_per_record as number | null) ?? null,
    querySavedAt: (r.query_saved_at as string) ?? null,
    healthStatus: (r.health_status as HealthStatus) ?? base.healthStatus,
    lastRunAt: (r.last_run_at as string) ?? null,
    lastSuccessAt: (r.last_success_at as string) ?? null,
    lastErrorAt: (r.last_error_at as string) ?? null,
    lastError: (r.last_error as string) ?? null,
    consecutiveFailures: (r.consecutive_failures as number) ?? 0,
    avgLatencyMs: (r.avg_latency_ms as number) ?? null,
    totalRuns: (r.total_runs as number) ?? 0,
    totalFailures: (r.total_failures as number) ?? 0,
  };
}

/**
 * Config for every adapter, defaults filled in for sources with no saved row.
 * `tableMissing` lets the page distinguish "nothing configured" from "the
 * migration hasn't run".
 */
export async function getAllSourceConfigs(): Promise<{ configs: Record<string, SourceConfig>; tableMissing: boolean }> {
  const configs: Record<string, SourceConfig> = {};
  for (const slug of Object.keys(SOURCE_SLUGS)) configs[slug] = defaultConfig(slug);

  try {
    const { data, error } = await configReader().from('source_config').select('*');
    if (error) {
      const missing = /does not exist|schema cache|relation/i.test(error.message);
      return { configs, tableMissing: missing };
    }
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const slug = r.slug as string;
      if (slug) configs[slug] = fromRow(r);
    }
    return { configs, tableMissing: false };
  } catch {
    return { configs, tableMissing: true };
  }
}

export async function getSourceConfig(slug: string): Promise<SourceConfig> {
  const { configs } = await getAllSourceConfigs();
  return configs[slug] ?? defaultConfig(slug);
}

/** Saves the editable fields. Health is never writable from the UI. */
export async function saveSourceConfig(
  slug: string,
  patch: Partial<
    Pick<
      SourceConfig,
      | 'isEnabled'
      | 'ingestMode'
      | 'scheduleCron'
      | 'timezone'
      | 'monthlyRequestCap'
      | 'pageSize'
      | 'maxRecordsPerRun'
      | 'timeoutMs'
      | 'rateLimitPerMinute'
      | 'dedupeStrategy'
      | 'queryParams'
      | 'enrichClaude'
      | 'enrichApollo'
      | 'enrichFillCommittee'
      | 'maxApolloCallsPerRecord'
      | 'maxClaudeCallsPerRecord'
    >
  >
): Promise<{ ok: boolean; message: string }> {
  if (!SOURCE_SLUGS[slug]) return { ok: false, message: `Unknown source "${slug}".` };
  if (!isSupabaseServiceConfigured()) return { ok: false, message: 'Supabase service role is not configured.' };

  const row: Record<string, unknown> = { slug };
  if (patch.isEnabled !== undefined) row.is_enabled = patch.isEnabled;
  if (patch.ingestMode !== undefined) row.ingest_mode = patch.ingestMode;
  if (patch.scheduleCron !== undefined) row.schedule_cron = patch.scheduleCron || null;
  if (patch.timezone !== undefined) row.timezone = patch.timezone;
  if (patch.monthlyRequestCap !== undefined) row.monthly_request_cap = patch.monthlyRequestCap;
  if (patch.pageSize !== undefined) row.page_size = Math.max(1, Math.min(200, patch.pageSize));
  if (patch.maxRecordsPerRun !== undefined)
    row.max_records_per_run = Math.max(1, Math.min(10_000, patch.maxRecordsPerRun));
  if (patch.timeoutMs !== undefined) row.timeout_ms = Math.max(1000, Math.min(300_000, patch.timeoutMs));
  if (patch.rateLimitPerMinute !== undefined) row.rate_limit_per_minute = patch.rateLimitPerMinute;
  if (patch.dedupeStrategy !== undefined) row.dedupe_strategy = patch.dedupeStrategy;
  if (patch.enrichClaude !== undefined) row.enrich_claude = patch.enrichClaude;
  if (patch.enrichApollo !== undefined) row.enrich_apollo = patch.enrichApollo;
  if (patch.enrichFillCommittee !== undefined) row.enrich_fill_committee = patch.enrichFillCommittee;
  if (patch.maxApolloCallsPerRecord !== undefined)
    row.max_apollo_calls_per_record = patch.maxApolloCallsPerRecord;
  if (patch.maxClaudeCallsPerRecord !== undefined)
    row.max_claude_calls_per_record = patch.maxClaudeCallsPerRecord;
  if (patch.queryParams !== undefined) {
    row.query_params = patch.queryParams;
    row.query_saved_at = new Date().toISOString();
  }

  const { error } = await getServiceSupabase().from('source_config').upsert(row, { onConflict: 'slug' });
  if (error) {
    const hint = /schema cache|does not exist/i.test(error.message)
      ? ' Run the source_config_and_runs migration first.'
      : '';
    return { ok: false, message: `${error.message}.${hint}` };
  }
  return { ok: true, message: 'Source configuration saved.' };
}

/**
 * Derives health from the rolling counters.
 *
 * Deliberately hysteretic: one failure is noise (a vendor blip, a timeout), so
 * a source is only "failing" after three consecutive failures. Anything that
 * has succeeded within a week and has a low error rate is healthy.
 */
export function deriveHealth(config: {
  isEnabled: boolean;
  consecutiveFailures: number;
  totalRuns: number;
  totalFailures: number;
  lastSuccessAt: string | null;
}): HealthStatus {
  if (!config.isEnabled) return 'disabled';
  if (config.totalRuns === 0) return 'unconfigured';
  if (config.consecutiveFailures >= 3) return 'failing';

  const errorRate = config.totalRuns > 0 ? config.totalFailures / config.totalRuns : 0;
  if (config.consecutiveFailures > 0 || errorRate > 0.25) return 'degraded';

  if (config.lastSuccessAt) {
    const daysSince = (Date.now() - new Date(config.lastSuccessAt).getTime()) / 86_400_000;
    if (daysSince > 7) return 'degraded';
  }
  return 'healthy';
}

/** Records a run's outcome against the source's rolling health. */
export async function recordRunOutcome(
  slug: string,
  outcome: { ok: boolean; durationMs: number; error?: string }
): Promise<void> {
  if (!isSupabaseServiceConfigured()) return;

  try {
    const service = getServiceSupabase();
    const { data } = await service.from('source_config').select('*').eq('slug', slug).maybeSingle();
    const current = data ? fromRow(data as Record<string, unknown>) : defaultConfig(slug);
    const now = new Date().toISOString();

    const totalRuns = current.totalRuns + 1;
    const totalFailures = current.totalFailures + (outcome.ok ? 0 : 1);
    const consecutiveFailures = outcome.ok ? 0 : current.consecutiveFailures + 1;

    // Rolling mean, so one slow run doesn't dominate the average.
    const avgLatencyMs = current.avgLatencyMs
      ? Math.round((current.avgLatencyMs * current.totalRuns + outcome.durationMs) / totalRuns)
      : outcome.durationMs;

    const next = {
      slug,
      total_runs: totalRuns,
      total_failures: totalFailures,
      consecutive_failures: consecutiveFailures,
      avg_latency_ms: avgLatencyMs,
      last_run_at: now,
      last_success_at: outcome.ok ? now : current.lastSuccessAt,
      last_error_at: outcome.ok ? current.lastErrorAt : now,
      last_error: outcome.ok ? current.lastError : (outcome.error ?? 'Unknown error'),
      health_status: deriveHealth({
        isEnabled: current.isEnabled,
        consecutiveFailures,
        totalRuns,
        totalFailures,
        lastSuccessAt: outcome.ok ? now : current.lastSuccessAt,
      }),
      requests_this_month: current.requestsThisMonth + 1,
    };

    await service.from('source_config').upsert(next, { onConflict: 'slug' });
  } catch {
    // Health tracking is observability, never a reason to fail an ingest.
  }
}

/** Whether a source may run right now, and why not if it can't. */
export function canRun(config: SourceConfig): { allowed: boolean; reason?: string } {
  if (!config.isEnabled) return { allowed: false, reason: 'Source is disabled.' };
  if (config.monthlyRequestCap !== null && config.requestsThisMonth >= config.monthlyRequestCap) {
    return {
      allowed: false,
      reason: `Monthly cap reached (${config.requestsThisMonth}/${config.monthlyRequestCap}).`,
    };
  }
  return { allowed: true };
}

/** Catalog entry for a slug — name, category and coverage for display. */
export function catalogFor(slug: string) {
  const sourceKey = SOURCE_SLUGS[slug]?.sourceKey;
  return SOURCE_CATALOG.find((s) => s.sourceKey === sourceKey) ?? null;
}
