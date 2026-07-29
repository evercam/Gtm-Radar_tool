import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getAllSourceConfigs, canRun } from '@/lib/sources/config';
import { getEnrichmentPolicy } from '@/lib/policies';
import { isCronSecret } from '@/lib/auth/cronSecret';
import { cronMatches } from '@/lib/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * GET|POST /api/cron?job=<name>
 *
 * The entrypoint an external scheduler calls. Until now the schedules stored
 * on each source were validated and displayed but nothing ever fired them —
 * this is what closes that gap.
 *
 * Deliberately NOT protected by the user session: a scheduler has no cookies.
 * It authenticates with a shared secret in the `Authorization` header instead,
 * and refuses to run at all when no secret is configured, so an unprotected
 * deployment cannot have its jobs triggered by anyone who finds the URL.
 *
 * Wire it up with any scheduler that can make an HTTP request:
 *
 *   curl -X POST https://your-app/api/cron?job=daily \
 *        -H "Authorization: Bearer $CRON_SECRET"
 *
 * Jobs:
 *   ingest      pull from every source whose schedule is due
 *   prioritise  select which records are worth enriching
 *   enrich      resolve accounts and find contacts for the queue
 *   assign      give finished leads an owner
 *   export      push assigned leads to Apollo
 *   daily       all five, in dependency order
 *
 * A lead's journey ends when it is enriched AND assigned, so both of those
 * steps have to run unattended — for a while they did not, and the schedule
 * quietly ingested and queued records that nothing ever finished.
 */

type JobName = 'ingest' | 'prioritise' | 'enrich' | 'assign' | 'export' | 'daily';
const JOBS: JobName[] = ['ingest', 'prioritise', 'enrich', 'assign', 'export', 'daily'];

interface JobResult {
  job: string;
  ok: boolean;
  message: string;
  detail?: unknown;
}

/**
 * Compares the caller's token to CRON_SECRET in constant time.
 *
 * This is the one place a shared secret is still an environment variable
 * rather than a database row: the scheduler must be able to authenticate
 * before any database read happens, so it cannot come from the encrypted
 * store.
 */
function authorized(request: NextRequest): { ok: true } | { ok: false; status: 401 | 503; message: string } {
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim()) {
    return {
      ok: false,
      status: 503,
      message: 'Scheduled jobs are disabled. Set CRON_SECRET to enable them.',
    };
  }

  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;

  if (!isCronSecret(token)) return { ok: false, status: 401, message: 'Unauthorized.' };
  return { ok: true };
}

/** Calls one of our own endpoints with the service context the job needs. */
async function callInternal(request: NextRequest, path: string, body: Record<string, unknown>): Promise<JobResult> {
  try {
    const res = await fetch(`${request.nextUrl.origin}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The internal marker lets the target route accept a machine caller;
        // it is only ever set here, after the shared secret has been checked.
        'x-cron-secret': process.env.CRON_SECRET ?? '',
      },
      body: JSON.stringify({ ...body, trigger: 'cron' }),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      message?: string;
      error?: string;
      fetched?: number;
      inserted?: number;
      updated?: number;
    };

    // Not every endpoint returns an `ok` flag — the ingest route answers with
    // counts. Requiring the flag marked every successful scheduled ingest as a
    // failure, which is worse than no reporting at all: it cries wolf until
    // nobody reads it.
    const ok = res.ok && json.ok !== false && !json.error;
    const message =
      json.message ??
      json.error ??
      (json.fetched !== undefined
        ? `${json.inserted ?? 0} new, ${json.updated ?? 0} updated of ${json.fetched} fetched.`
        : `HTTP ${res.status}`);

    return { job: path, ok, message, detail: json };
  } catch (err) {
    return { job: path, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function runIngest(request: NextRequest, at: Date): Promise<JobResult> {
  const { configs, tableMissing } = await getAllSourceConfigs();
  if (tableMissing) return { job: 'ingest', ok: false, message: 'source_config is missing — run the migration.' };

  const due = Object.values(configs).filter(
    (c) => c.ingestMode === 'cron' && canRun(c).allowed && c.scheduleCron && cronMatches(c.scheduleCron, at)
  );

  if (due.length === 0) return { job: 'ingest', ok: true, message: 'No source is scheduled for this minute.' };

  const results = await Promise.all(due.map((c) => callInternal(request, `/api/ingest/${c.slug}`, {})));
  const ok = results.filter((r) => r.ok).length;
  return {
    job: 'ingest',
    ok: ok > 0 || results.length === 0,
    message: `Ran ${results.length} source(s), ${ok} succeeded.`,
    detail: results,
  };
}

export async function POST(request: NextRequest) {
  const auth = authorized(request);
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: false, message: 'Supabase service key not configured.' }, { status: 200 });
  }

  const job = (request.nextUrl.searchParams.get('job') ?? 'daily') as JobName;
  if (!JOBS.includes(job)) {
    return NextResponse.json(
      { ok: false, message: `Unknown job "${job}". One of: ${JOBS.join(', ')}.` },
      { status: 400 }
    );
  }

  const startedAt = Date.now();
  const at = new Date();
  const results: JobResult[] = [];

  // Order matters, and each step feeds the next: ingest brings records in,
  // prioritisation picks which are worth spending on, enrichment finds the
  // contact, assignment gives it an owner, and only then is there anything to
  // export. Running them in any other order just delays everything by a day.
  if (job === 'ingest' || job === 'daily') results.push(await runIngest(request, at));
  if (job === 'prioritise' || job === 'daily') results.push(await callInternal(request, '/api/prioritize', {}));
  if (job === 'enrich' || job === 'daily') results.push(await callInternal(request, '/api/enrich/batch', {}));
  if (job === 'assign' || job === 'daily') {
    results.push(await callInternal(request, '/api/leads', { action: 'autoAssign' }));
  }
  if (job === 'export' || job === 'daily') {
    const { config: policy } = await getEnrichmentPolicy();
    results.push(await callInternal(request, '/api/export/apollo', { limit: policy.apolloBatchSize }));
  }

  // Record the run so a silent scheduler failure is visible rather than just
  // being an absence of activity.
  try {
    await getServiceSupabase()
      .from('cron_runs')
      .insert({
        job,
        results,
        ok: results.every((r) => r.ok),
        duration_ms: Date.now() - startedAt,
      });
  } catch {
    // best-effort
  }

  return NextResponse.json({
    ok: results.every((r) => r.ok),
    job,
    ranAt: at.toISOString(),
    durationMs: Date.now() - startedAt,
    results,
  });
}

/** GET is accepted too — many schedulers can only issue a GET. */
export async function GET(request: NextRequest) {
  return POST(request);
}
