import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getAllSourceConfigs, canRun } from '@/lib/sources/config';
import { getEnrichmentPolicy } from '@/lib/policies';
import { isCronSecret } from '@/lib/auth/cronSecret';
import { isDue } from '@/lib/cron';
import { logEventAsync } from '@/lib/observability/events';

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
 *   score       score and route what arrived — nothing can be selected unscored
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

/*
  `cycle` is everything except ingest, and it is the job that should run hourly.

  Assign and export previously existed ONLY inside `daily`. So on any day the
  once-a-day cron did not fire, nothing reached Apollo at all — measured on
  12 August: 38 leads eligible to send, 648 waiting to be assigned, the full
  100-lead quota unused, and no daily run. The hourly trigger fired 14 times that
  morning and could only enrich and brief, both of which had nothing to do because
  prioritise also lives in `daily`.

  Safe to run hourly because the caps are per DAY, not per run: assignment counts
  `owner_assigned_at >= midnight` so it tops up TO each person's 25 and stops, and
  export only sends what is already assigned. Enrichment is bounded by batchSize
  and the daily/monthly spend rails. Running this twenty-four times cannot exceed
  what running it once was allowed to do.

  Ingest is excluded deliberately — it is the expensive, rate-limited part and it
  has its own per-source schedules.
*/
type JobName = 'ingest' | 'score' | 'prioritise' | 'enrich' | 'brief' | 'assign' | 'export' | 'cycle' | 'daily';
const JOBS: JobName[] = ['ingest', 'score', 'prioritise', 'enrich', 'brief', 'assign', 'export', 'cycle', 'daily'];

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
/**
 * Where this app can call itself.
 *
 * NOT `request.nextUrl.origin`. Vercel invokes a cron against the DEPLOYMENT
 * url, and deployment urls are covered by Deployment Protection even when the
 * production domain is not — so every self-call was answered by the edge with
 * 401 "Protected deployment" and four of the five daily stages had never run.
 * Nothing in the app logged a fault, because the app was never reached.
 *
 * `VERCEL_PROJECT_PRODUCTION_URL` is the production domain, injected by Vercel,
 * and it is not protected. `CRON_BASE_URL` overrides it for anyone hosting
 * elsewhere; the origin remains the fallback so local runs keep working.
 */
function selfBase(request: NextRequest): string {
  const explicit = process.env.CRON_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) return `https://${production.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;

  return request.nextUrl.origin;
}

async function callInternal(request: NextRequest, path: string, body: Record<string, unknown>): Promise<JobResult> {
  try {
    const res = await fetch(`${selfBase(request)}${path}`, {
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
    // Due, not "matches this minute" — see isDue. Vercel fired a 0 6 * * * cron
    // at 06:59, so minute-exact matching skipped every scheduled source.
    (c) => c.ingestMode === 'cron' && canRun(c).allowed && c.scheduleCron && isDue(c.scheduleCron, c.lastRunAt, at)
  );

  if (due.length === 0) return { job: 'ingest', ok: true, message: 'No source is due — every schedule has run since its last occurrence.' };

  /*
    A CONCURRENCY CAP, because `Promise.all` over every due source is what was
    losing the data.

    Measured 2026-08-13 from `ingestion_runs`: thirteen of twenty-five sources
    failed on "canceling statement due to statement timeout" during their upsert,
    every one of them stamped 06:17 — the same instant. glenigan 11/13 runs,
    nyc-permits 7/9, sec-edgar 7/14, chicago-permits 5/9, planning-ie 5/9. The
    records were fetched correctly and then thrown away.

    The sizes prove it is contention rather than volume: austender timed out on
    "records 0-52 of 52" and electrive on "records 0-30 of 30". Thirty rows do not
    time out alone. They time out waiting behind twenty-four other sources upserting
    into the same table, against a shared statement timeout, while every row updates
    48 indexes.

    Two at a time. Not one, because the fetches are IO-bound and mostly waiting on
    other people's APIs — serialising entirely would make a slow publisher block
    every source behind it, and news-search alone takes 125 seconds. Not more,
    because the whole point is to stop the pile-up at the write.

    This is the fix that needs no migration. Dropping the two unread GIN indexes
    (20260813120000) attacks the per-row cost from the other side; they compound.
  */
  const INGEST_CONCURRENCY = 2;
  const results: JobResult[] = [];
  const queue = [...due];
  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      results.push(await callInternal(request, `/api/ingest/${next.slug}`, {}));
    }
  };
  await Promise.all(Array.from({ length: Math.min(INGEST_CONCURRENCY, queue.length) }, worker));

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

  /*
    A wall-clock budget, because the chain is one request and the platform kills
    it without a word.

    Each step is its own internal HTTP call with its own timeout, but this handler
    awaits every one of them, so `maxDuration` here is the real ceiling. On
    12 August the daily run ingested seven sources — stamping last_run_at at 06:17
    — and then vanished: no cron_runs row, no step events, nothing assigned,
    nothing exported. It read as "the cron never fired".

    240s against a 300s limit leaves room to finish the step in flight, write the
    run row, and respond. Steps that do not fit are reported as skipped rather
    than silently absent, and `cycle` picks them up within the hour.
  */
  const BUDGET_MS = 240_000;
  const outOfTime = () => Date.now() - startedAt > BUDGET_MS;
  const skipped: string[] = [];

  /**
   * Run a step unless the budget is gone.
   *
   * Returns nothing and pushes into `results`, so the call sites stay readable as
   * a sequence — the order of this chain is the thing a reader most needs to see.
   */
  const step = async (name: string, enabled: boolean, run: () => Promise<JobResult>): Promise<void> => {
    if (!enabled) return;
    if (outOfTime()) {
      skipped.push(name);
      results.push({
        job: name,
        ok: false,
        message: `Skipped — ${Math.round((Date.now() - startedAt) / 1000)}s of the ${BUDGET_MS / 1000}s budget used before this step. It runs on the next hourly cycle.`,
      });
      logEventAsync({ kind: 'cron', name: `${job}.${name}`, ok: false, detail: { skipped: true, budgetMs: BUDGET_MS } });
      return;
    }
    const stepStarted = Date.now();
    const result = await run();
    results.push(result);
    /*
      Logged here, not in a loop after the chain.

      A pass at the end only records steps if the handler survives to reach it —
      which is exactly what did not happen on 12 August. Written per step, the log
      shows how far a killed run got.

      `${job}.${name}` rather than the step alone: the same step runs on its own
      schedule and inside `daily`/`cycle`, and the brief queue failing hourly while
      succeeding daily was that whole bug. Collapsing them would hide it.
    */
    logEventAsync({
      kind: 'cron',
      name: `${job}.${name}`,
      ok: result.ok,
      durationMs: Date.now() - stepStarted,
      detail: { message: result.message },
    });
  };

  /*
    The run row is opened BEFORE any work and closed after.

    It used to be inserted only at the end, so a run that died partway left no
    trace at all — which is precisely how three days of missed exports looked like
    a scheduler that was never triggered. An open row with ok=false is the honest
    state of a run in progress, and it stays that way if the function is killed.
  */
  let runId: string | null = null;
  try {
    const { data } = await getServiceSupabase()
      .from('cron_runs')
      .insert({ job, ok: false, results: [], duration_ms: null })
      .select('id')
      .maybeSingle();
    runId = (data as { id?: string } | null)?.id ?? null;
  } catch {
    // Best-effort: not being able to record the run must not stop the run.
  }

  // Order matters, and each step feeds the next: ingest brings records in,
  // prioritisation picks which are worth spending on, enrichment finds the
  // contact, assignment gives it an owner, and only then is there anything to
  // export. Running them in any other order just delays everything by a day.
  await step('ingest', job === 'ingest' || job === 'daily', () => runIngest(request, at));
  // Between ingest and prioritisation, because prioritisation selects on band and
  // score: a record ingested this morning has neither until this runs, so it is
  // invisible to every enrichment rule. The chain had no scoring step at all —
  // newly ingested records simply never became selectable, and the only way to
  // score them was a button that cannot finish inside a function timeout.
  //
  // Scoped to unscored records, so this costs roughly what arrived today. A
  // policy change still needs the full pass, run deliberately.
  await step('score', job === 'score' || job === 'cycle' || job === 'daily', () =>
    callInternal(request, '/api/routing/apply', { scope: 'unscored' })
  );
  await step('prioritise', job === 'prioritise' || job === 'cycle' || job === 'daily', () => callInternal(request, '/api/prioritize', {}));
  await step('enrich', job === 'enrich' || job === 'cycle' || job === 'daily', () => callInternal(request, '/api/enrich/batch', {}));
  // After enrich, before assign: a brief is worth most while the lead is still
  // waiting to be handed to somebody. It is also the only step allowed to come
  // back empty without the day being a failure — briefs that do not finish stay
  // queued for tomorrow, and nothing downstream waits on one.
  await step('brief', job === 'brief' || job === 'cycle' || job === 'daily', () => callInternal(request, '/api/enrich/brief', {}));
  /*
    Assign and export are LAST in the chain and were therefore always the first
    casualties of the timeout. They are the two steps that actually put leads in
    front of a seller, so the budget above exists mostly to protect them.
  */
  await step('assign', job === 'assign' || job === 'cycle' || job === 'daily', () =>
    callInternal(request, '/api/leads', { action: 'autoAssign' })
  );
  await step('export', job === 'export' || job === 'cycle' || job === 'daily', async () => {
    const { config: policy } = await getEnrichmentPolicy();
    return callInternal(request, '/api/export/apollo', { limit: policy.apolloBatchSize });
  });

  /*
    Retention, here because the daily job is the only thing that runs reliably
    and unattended. app_events takes a row per notable event, so without this it
    grows without bound and a log that fills the database is a worse problem than
    the one it was added to solve.

    Only on `daily` — running it on every 15-minute tick would be 96 pointless
    deletes a day against a table that gains rows slowly.
  */
  if (job === 'daily') {
    try {
      const { data: pruned } = await getServiceSupabase().rpc('prune_app_events');
      if (typeof pruned === 'number' && pruned > 0) {
        logEventAsync({ kind: 'cron', name: 'daily.prune_events', ok: true, detail: { removed: pruned } });
      }
    } catch (err) {
      // Best-effort: a failed prune must not fail the day's run.
      logEventAsync({
        kind: 'cron',
        name: 'daily.prune_events',
        ok: false,
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /*
    Close the row opened at the top. An update rather than an insert, so a run that
    died partway leaves its opened row behind as evidence instead of leaving
    nothing — which is what made three days of missed exports look like a
    scheduler that had never been triggered.
  */
  try {
    const service = getServiceSupabase();
    const payload = {
      results,
      ok: results.length > 0 && results.every((r) => r.ok),
      duration_ms: Date.now() - startedAt,
    };
    if (runId) await service.from('cron_runs').update(payload).eq('id', runId);
    else await service.from('cron_runs').insert({ job, ...payload });
  } catch {
    // best-effort
  }

  return NextResponse.json({
    ok: results.every((r) => r.ok),
    job,
    ranAt: at.toISOString(),
    durationMs: Date.now() - startedAt,
    /*
      `complete` is what a caller should branch on. `ok` means nothing threw; a run
      that ran out of budget and skipped the export has no failing step and would
      otherwise report success.
    */
    complete: skipped.length === 0,
    skipped,
    results,
  });
}

/** GET is accepted too — many schedulers can only issue a GET. */
export async function GET(request: NextRequest) {
  return POST(request);
}
