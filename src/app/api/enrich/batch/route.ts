import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getEnrichmentPolicy } from '@/lib/policies';
import { loadSourceBudgets, budgetFor } from '@/lib/enrich/sourceBudget';
import { getEnrichmentQueue, getEnrichedSinceCount, getProductionState, type EnrichQueueRow } from '@/lib/queries';
import { getDemandPlan, planDemandFill } from '@/lib/enrich/demand';
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

  let body: { bu?: string; route?: string; stage?: string; band?: string; limit?: number; dryRun?: boolean; force?: boolean } = {};
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

  /*
    A rail whose usage cannot be measured is not a rail.

    getEnrichedSinceCount used to return 0 when its count failed, and this read
    that as "nothing enriched yet" — so a cap of 600 with an unmeasurable usage
    became no cap at all. The count was in fact being cancelled by the statement
    timeout every single time, because enriched_at was unindexed, so both rails
    have been reading zero used for as long as the table has been too big to scan.

    It now returns null and this refuses to spend. Failing closed is the only
    defensible direction: the cost of a skipped run is an hour of delay, and the
    cost of an unbounded run is Apollo credits nobody authorised. Every other
    silent zero in this codebase misreported a number; this one spends money.
  */
  const unmeasured = [
    enrichedToday === null ? 'the last 24h' : null,
    policy.monthlyCap > 0 && enrichedMonth === null ? 'the last 30 days' : null,
  ].filter(Boolean);
  if (unmeasured.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        message:
          `Refusing to enrich: cannot measure how much has already been enriched in ${unmeasured.join(' or ')}, ` +
          `so the spend caps cannot be enforced. Apply the enriched_at index (20260811180000) and retry.`,
      },
      { status: 200 }
    );
  }

  const rails = [
    { name: 'Daily', used: enrichedToday ?? 0, cap: policy.dailyCap, window: 'the last 24h' },
    { name: 'Monthly', used: enrichedMonth ?? 0, cap: policy.monthlyCap, window: 'the last 30 days' },
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

  /**
   * The monthly production gate.
   *
   * The target is a flow — enriched leads per calendar month — so the only reason
   * not to run with an eligible queue is that the month's number is already made.
   * That is a normal outcome, so it returns `ok` with the reason rather than an
   * error: a scheduled job reporting failure for working correctly teaches
   * everyone to ignore its output.
   *
   * `force` overrides, for a deliberate top-up beyond the month's budget.
   */
  const buffer = await getProductionState(policy.monthlyReadyTarget);
  if (buffer.reason && !body.force) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      message: buffer.reason,
      production: buffer,
      requested: 0,
      succeeded: 0,
      failed: 0,
      results: [],
    });
  }

  /**
   * Never overshoot the month. With 4 left to make and a batch of 10, enrich 4 —
   * otherwise one run sails past the ceiling the ceiling exists to enforce.
   */
  const room = buffer.target > 0 ? buffer.remaining : effectiveLimit;
  const limitToRoom = Math.min(effectiveLimit, room);

  /**
   * Fill by DEMAND, not by score alone.
   *
   * Score order answers "which lead is most valuable"; it does not answer "what
   * should we produce next", and the two diverge the moment anybody has a scope.
   * Measured on this roster: a score-ordered batch of ten returned hydro, oil and
   * gas, and solar — nothing at all for the rep scoped to mining, who would have
   * watched a 1,440-lead tank fill with leads he can never be given.
   *
   * `planDemandFill` splits the slots by how short each person is and reads the
   * queue once per person inside their own scope. Priority still decides WHICH
   * record within a person, so the bar does not drop.
   */
  // Per-person split of the month's target, weighted by each quota.
  const demand = await getDemandPlan(policy.monthlyReadyTarget);
  const fill = await planDemandFill({ ...filters, limit: limitToRoom }, demand, limitToRoom);
  const rows = fill.rows;
  const unreachableSkipped = fill.unreachableSkipped;
  const { total } = await getEnrichmentQueue({ ...filters, limit: 1 });

  /*
    A failed queue read is not an empty queue, and this is the endpoint where the
    difference costs the most.

    With no rows this returned `ok: true` and "Nothing in the queue matches the
    current policy and filters" — a confident statement about the book. A read that
    timed out produces exactly the same zero rows, so the nightly batch would report
    success, enrich nobody, and leave no trace that anything went wrong. Measured
    2026-08-13, the queue query was failing roughly half the time.
  */
  if (rows.length === 0 && fill.failed) {
    return NextResponse.json({
      ok: false,
      message:
        'The enrichment queue could not be read, so nothing was enriched. This is a failed read, not an empty queue — retry rather than assuming there is no work.',
      requested: 0,
      succeeded: 0,
      failed: 0,
      queueTotal: total,
      unreachableSkipped,
      buffer,
      results: [],
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      message: 'Nothing in the queue matches the current policy and filters.',
      requested: 0,
      succeeded: 0,
      failed: 0,
      queueTotal: total,
    unreachableSkipped,
    buffer,
    demand: { perPerson: fill.perPerson, starved: fill.starved, totalDeficit: demand.totalDeficit },
      results: [],
    });
  }

  // A dry run reports exactly what WOULD be spent, without spending it.
  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      message:
        `${rows.length} record${rows.length === 1 ? '' : 's'} would be enriched` +
        // null is "we could not count", which must not print as "(0 in queue)".
        (total === null ? ' (queue size unavailable).' : ` (${total.toLocaleString()} in queue).`),
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
  // How many are actually contactable. Apollo's search says an address EXISTS;
  // only a revealed one can be sent anywhere, so a count of contacts alone
  // reads as progress that export cannot use.
  let contactsWithEmail = 0;

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
            // Timing, for the call brief. Passed through rather than re-read:
            // the queue already selects them.
            current_phase: r.current_phase,
            construction_start_date: r.construction_start_date,
            estimated_completion_date: r.estimated_completion_date,
            announced_date: r.announced_date,
            bid_date: r.bid_date,
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
          contactsWithEmail += res.contacts.filter((c) => c.email).length;
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
      : `Enriched ${succeeded} of ${rows.length} — ${contactsFound} contact${contactsFound === 1 ? '' : 's'} found (${contactsWithEmail} with an email), ${fieldsAdded} field${fieldsAdded === 1 ? '' : 's'} filled${failed ? `, ${failed} failed` : ''}.` +
        // Said out loud, because a queue that quietly drops records looks like a
        // queue that has run out of work. This is spend avoided, not work lost.
        (unreachableSkipped > 0
          ? ` Skipped ${unreachableSkipped} already-built or cancelled project${unreachableSkipped === 1 ? '' : 's'} — no contacts bought for work that is over.`
          : '') +
        // Starvation named, with the scope that could not be served. This is a
        // sourcing problem, not a full tank, and the two must never look alike.
        (fill.starved.length
          ? ` Could not source for ${fill.starved
              .map((x) => `${x.name} (${x.wanted} short; ${[x.scope.verticals.join('/'), x.scope.bu.join('/'), x.scope.regions.join('/')].filter(Boolean).join(', ') || 'no scope'})`)
              .join('; ')}.`
          : ''),
    requested: rows.length,
    succeeded,
    failed,
    fieldsAdded,
    contactsFound,
    contactsWithEmail,
    queueTotal: total,
    durationMs,
    results,
  });
}
