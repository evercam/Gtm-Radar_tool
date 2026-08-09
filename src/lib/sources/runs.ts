import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';

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
 * Ingestion run history — what ran, over what, and what came back.
 *
 * A run row is opened before the adapter is called and closed after, so an
 * interrupted or crashed run still leaves a `running` row rather than
 * vanishing. That is deliberate: a stuck run is visible on the seeding page,
 * whereas a missing one looks like nothing ever happened.
 */

export interface IngestionRun {
  id: string;
  slug: string;
  sourceKey: string | null;
  trigger: 'manual' | 'cron' | 'backfill';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  fetched: number;
  normalized: number;
  inserted: number;
  updated: number;
  duplicates: number;
  failed: number;
  error: string | null;
  errorKind: string | null;
  /** How the run was fed. `via: 'push'` means a collector posted the data in. */
  params: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

function fromRow(r: Record<string, unknown>): IngestionRun {
  return {
    id: r.id as string,
    slug: r.slug as string,
    sourceKey: (r.source_key as string) ?? null,
    trigger: (r.trigger as IngestionRun['trigger']) ?? 'manual',
    status: (r.status as IngestionRun['status']) ?? 'running',
    fetched: (r.fetched as number) ?? 0,
    normalized: (r.normalized as number) ?? 0,
    inserted: (r.inserted as number) ?? 0,
    updated: (r.updated as number) ?? 0,
    duplicates: (r.duplicates as number) ?? 0,
    failed: (r.failed as number) ?? 0,
    error: (r.error as string) ?? null,
    errorKind: (r.error_kind as string) ?? null,
    params: (r.params as Record<string, unknown>) ?? {},
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? null,
    durationMs: (r.duration_ms as number) ?? null,
  };
}

/** Opens a run row. Returns null if history is unavailable — never throws. */
export async function startRun(params: {
  slug: string;
  sourceKey?: string | null;
  trigger?: IngestionRun['trigger'];
  triggeredBy?: string | null;
  params?: Record<string, unknown>;
}): Promise<string | null> {
  if (!isSupabaseServiceConfigured()) return null;
  try {
    const { data } = await getServiceSupabase()
      .from('ingestion_runs')
      .insert({
        slug: params.slug,
        source_key: params.sourceKey ?? null,
        trigger: params.trigger ?? 'manual',
        triggered_by: params.triggeredBy ?? null,
        params: params.params ?? {},
        status: 'running',
      })
      .select('id')
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/** Closes a run row with its outcome. */
export async function finishRun(
  runId: string | null,
  outcome: {
    ok: boolean;
    fetched?: number;
    normalized?: number;
    inserted?: number;
    updated?: number;
    duplicates?: number;
    failed?: number;
    error?: string;
    errorKind?: string;
    startedAtMs: number;
  }
): Promise<void> {
  if (!runId || !isSupabaseServiceConfigured()) return;
  try {
    await getServiceSupabase()
      .from('ingestion_runs')
      .update({
        status: outcome.ok ? 'completed' : 'failed',
        fetched: outcome.fetched ?? 0,
        normalized: outcome.normalized ?? 0,
        inserted: outcome.inserted ?? 0,
        updated: outcome.updated ?? 0,
        duplicates: outcome.duplicates ?? 0,
        failed: outcome.failed ?? 0,
        error: outcome.error ?? null,
        error_kind: outcome.errorKind ?? null,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - outcome.startedAtMs,
      })
      .eq('id', runId);
  } catch {
    // best-effort
  }
}

export async function getIngestionRuns(
  options: { slug?: string; limit?: number } = {}
): Promise<{ runs: IngestionRun[]; tableMissing: boolean }> {
  try {
    let query = configReader()
      .from('ingestion_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(Math.min(200, options.limit ?? 25));
    if (options.slug) query = query.eq('slug', options.slug);

    const { data, error } = await query;
    if (error) {
      return { runs: [], tableMissing: /does not exist|schema cache|relation/i.test(error.message) };
    }
    return { runs: ((data ?? []) as Record<string, unknown>[]).map(fromRow), tableMissing: false };
  } catch {
    return { runs: [], tableMissing: true };
  }
}

/**
 * How long a run may be `running` before it is presumed dead.
 *
 * The ingest route's own ceiling is 300 seconds, so nothing legitimate is still
 * going after thirty minutes — a row that old is a process that was killed, lost
 * its container, or crashed somewhere `finishRun` could not reach.
 *
 * Generous on purpose: reaping a run that is merely slow would report a failure
 * that did not happen, and the cost of waiting is a stale row for a few extra
 * minutes.
 */
const STALE_RUN_MS = 30 * 60 * 1000;

/**
 * Closes runs that will never close themselves.
 *
 * `startRun` deliberately opens a row before the adapter is called so an
 * interrupted run stays visible rather than vanishing — but nothing ever ended
 * those rows, so a killed process left a run marked `running` for good. Two sat
 * on the Sources page for days looking like live progress, and the page has no
 * way to tell them from a pull that started a second ago.
 *
 * Marked `failed` with a plain explanation rather than deleted: the run did
 * happen, and how it ended is exactly what somebody reading the history wants.
 */
export async function reapStaleRuns(): Promise<number> {
  if (!isSupabaseServiceConfigured()) return 0;
  const cutoff = new Date(Date.now() - STALE_RUN_MS).toISOString();
  try {
    const { data, error } = await configReader()
      .from('ingestion_runs')
      .update({
        status: 'failed',
        error: 'Interrupted — the process ended before the run could finish.',
        error_kind: 'interrupted',
        finished_at: new Date().toISOString(),
      })
      .eq('status', 'running')
      .lt('started_at', cutoff)
      .select('id');
    if (error) return 0;
    return (data ?? []).length;
  } catch {
    return 0;
  }
}

/**
 * Runs still genuinely in flight — surfaced as live progress on the seeding page.
 *
 * Reaps first, so a dead run is never shown as live. Cheap: the update touches
 * nothing on the common path where no run is stale.
 */
export async function getActiveRuns(): Promise<IngestionRun[]> {
  try {
    await reapStaleRuns();
    const { data, error } = await (
      configReader()
    )
      .from('ingestion_runs')
      .select('*')
      .eq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(20);
    if (error) return [];
    return ((data ?? []) as Record<string, unknown>[]).map(fromRow);
  } catch {
    return [];
  }
}
