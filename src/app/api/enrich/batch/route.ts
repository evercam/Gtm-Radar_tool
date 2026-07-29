import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getEnrichmentPolicy } from '@/lib/policies';
import { loadSourceBudgets, budgetFor } from '@/lib/enrich/sourceBudget';
import { getEnrichmentQueue, getEnrichedSinceCount, type EnrichQueueRow } from '@/lib/queries';
import { runEnrichment } from '@/lib/enrich/run';
import { isClaudeConfigured } from '@/lib/enrich/claude';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
// A batch is N sequential enrichments, each with a web search — give it room.
export const maxDuration = 300;

interface BatchResult {
  id: string;
  name: string;
  ok: boolean;
  account: string | null;
  contacts: number;
  fields: number;
  message?: string;
}

/**
 * POST /api/enrich/batch
 *
 * Works the enrichment queue in priority order: selects the eligible records
 * under the admin policy, enriches them with bounded concurrency, and records
 * the job in `enrichment_runs`.
 *
 * Every spend guard comes from the policy, not the caller — the request may
 * narrow the selection (a BU, a lane, a smaller batch) but can never widen it
 * past maxBatchSize, minPriorityScore or the daily cap.
 */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('enrichment.run');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        message:
          'Supabase service key not configured — batch enrichment writes results back, so it needs the service role.',
      },
      { status: 200 }
    );
  }
  if (!isClaudeConfigured()) {
    return NextResponse.json(
      { ok: false, message: 'Set ANTHROPIC_API_KEY in .env.local to run enrichment.' },
      { status: 200 }
    );
  }

  let body: { bu?: string; route?: string; stage?: string; band?: string; limit?: number; dryRun?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    // no body — run with the policy defaults
  }

  const { config: policy } = await getEnrichmentPolicy();

  // The request may only narrow what the policy already allows.
  const limit = Math.min(body.limit && body.limit > 0 ? body.limit : policy.batchSize, policy.maxBatchSize);
  const filters = {
    bu: body.bu,
    route: body.route,
    stage: body.stage,
    // The policy's bands are the standing rule; a request may narrow within
    // them but never past them.
    bands: policy.bands,
    band: body.band && policy.bands.includes(body.band) ? body.band : undefined,
    recordTypes: policy.recordTypes,
    bus: policy.bus,
    verticals: policy.verticals,
    minEstimatedValue: policy.minEstimatedValue,
    requireCompany: policy.requireCompany,
    minPriority: policy.minPriorityScore,
    reenrichAfterDays: policy.reenrichAfterDays,
    onlyMissingContact: policy.onlyMissingContact,
    limit,
  };

  // Spend rails — counted from enriched_at, so they survive restarts and are
  // not fooled by a second worker. Both apply; the tighter one wins.
  const [enrichedToday, enrichedMonth] = await Promise.all([
    getEnrichedSinceCount(1),
    policy.monthlyCap > 0 ? getEnrichedSinceCount(30) : Promise.resolve(0),
  ]);

  const rails = [
    { name: 'Daily', used: enrichedToday, cap: policy.dailyCap, window: 'the last 24h' },
    { name: 'Monthly', used: enrichedMonth, cap: policy.monthlyCap, window: 'the last 30 days' },
  ].filter((r) => r.cap > 0);

  const hit = rails.find((r) => r.used >= r.cap);
  if (hit) {
    return NextResponse.json(
      {
        ok: false,
        message: `${hit.name} cap reached — ${hit.used.toLocaleString()} records enriched in ${hit.window} (cap ${hit.cap.toLocaleString()}). Raise it on the Enrichment page to continue.`,
      },
      { status: 200 }
    );
  }
  const effectiveLimit = rails.reduce((n, r) => Math.min(n, r.cap - r.used), limit);

  const { rows, total } = await getEnrichmentQueue({ ...filters, limit: effectiveLimit });
  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      message: 'Nothing in the queue matches the current policy and filters.',
      requested: 0,
      succeeded: 0,
      failed: 0,
      queueTotal: total,
      results: [],
    });
  }

  // A dry run reports exactly what WOULD be spent, without spending it.
  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      message: `${rows.length} record${rows.length === 1 ? '' : 's'} would be enriched (${total.toLocaleString()} in queue).`,
      requested: rows.length,
      queueTotal: total,
      results: rows.map((r) => ({
        id: r.id,
        name: r.canonical_name,
        ok: true,
        account: r.company_name_raw,
        contacts: 0,
        fields: 0,
      })),
    });
  }

  const service = getServiceSupabase();
  const startedAt = Date.now();

  // Per-source budgets, resolved once: a batch spans many sources and reading
  // the configs per record would be a query per lead.
  const budgets = await loadSourceBudgets(policy);

  // Open the run row first so an interrupted batch still leaves a trace.
  let runId: string | null = null;
  try {
    const { data } = await service
      .from('enrichment_runs')
      .insert({
        filters,
        requested: rows.length,
        engines: { claude: policy.engines.claude, apollo: policy.engines.apollo, gleif: policy.engines.gleif },
        status: 'running',
      })
      .select('id')
      .maybeSingle();
    runId = (data as { id: string } | null)?.id ?? null;
  } catch {
    // History is best-effort — never block the actual enrichment on it.
  }

  const results: BatchResult[] = [];
  let succeeded = 0;
  let failed = 0;
  // Set when a failure will repeat identically for every remaining record —
  // no credit, a rejected key. Continuing would burn the daily cap producing
  // a hundred copies of the same message.
  let fatal: string | null = null;
  let fieldsAdded = 0;
  let contactsFound = 0;

  // Bounded concurrency: a pool of workers pulling from one cursor. Keeps the
  // Anthropic/Apollo rate limits happy without serializing the whole batch.
  let cursor = 0;
  async function worker() {
    for (;;) {
      if (fatal) return;
      const index = cursor++;
      if (index >= rows.length) return;
      const r: EnrichQueueRow = rows[index];
      try {
        const res = await runEnrichment(
          {
            id: r.id,
            canonical_name: r.canonical_name,
            record_type: r.record_type,
            icp_code: r.icp_code,
            company_name_raw: r.company_name_raw,
            contact_name: r.contact_name,
            contact_email: r.contact_email,
            contact_phone: r.contact_phone,
            description: r.description,
            city: r.city,
            state_province: r.state_province,
            country: r.country,
            estimated_value: r.estimated_value,
            estimated_value_currency: r.estimated_value_currency,
            source_key: r.source_key,
            project_url: r.project_url,
            // Decides which sales play's buying committee gets searched.
            vertical: r.vertical,
          },
          policy,
          budgetFor(budgets, r.source_key, policy)
        );
        if (res.ok) {
          succeeded += 1;
          fieldsAdded += res.applied?.length ?? 0;
          contactsFound += res.contacts.length;
        } else {
          failed += 1;
          if (res.fatal) fatal ??= res.message ?? 'Provider unavailable.';
        }
        results.push({
          id: r.id,
          name: r.canonical_name,
          ok: res.ok,
          account: res.account?.name ?? null,
          contacts: res.contacts.length,
          fields: res.applied?.length ?? 0,
          message: res.ok ? undefined : res.message,
        });
      } catch (err) {
        failed += 1;
        results.push({
          id: r.id,
          name: r.canonical_name,
          ok: false,
          account: null,
          contacts: 0,
          fields: 0,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(policy.concurrency, rows.length) }, worker));

  const durationMs = Date.now() - startedAt;
  if (runId) {
    try {
      await service
        .from('enrichment_runs')
        .update({
          succeeded,
          failed,
          skipped: Math.max(0, rows.length - succeeded - failed),
          fields_added: fieldsAdded,
          contacts_found: contactsFound,
          results,
          status: fatal || failed === rows.length ? 'failed' : 'completed',
          error: fatal,
          finished_at: new Date().toISOString(),
          duration_ms: durationMs,
        })
        .eq('id', runId);
    } catch {
      // best-effort
    }
  }

  const stopped = rows.length - succeeded - failed;

  return NextResponse.json({
    // A provider that cannot be reached at all is not a successful run, even
    // though the endpoint itself worked.
    ok: !fatal,
    runId,
    fatal,
    message: fatal
      ? `Stopped after ${succeeded + failed} of ${rows.length}. ${fatal}${stopped > 0 ? ` ${stopped} record${stopped === 1 ? '' : 's'} left untouched in the queue.` : ''}`
      : `Enriched ${succeeded} of ${rows.length} — ${contactsFound} contact${contactsFound === 1 ? '' : 's'} found, ${fieldsAdded} field${fieldsAdded === 1 ? '' : 's'} filled${failed ? `, ${failed} failed` : ''}.`,
    requested: rows.length,
    succeeded,
    failed,
    fieldsAdded,
    contactsFound,
    queueTotal: total,
    durationMs,
    results,
  });
}
