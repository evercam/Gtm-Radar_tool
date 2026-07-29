import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { checkPermission } from '@/lib/auth/session';
import { getEnrichmentPolicy } from '@/lib/policies';
import { getEnrichmentRules } from '@/lib/enrich/rulesStore';
import { selectForEnrichment, type PrioritizableRecord } from '@/lib/enrich/rules';
import { transitionMany } from '@/lib/lifecycleStore';
import { getEnrichedTodayCount } from '@/lib/queries';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/prioritize
 *
 * The daily selection pass. Reads every idle record, runs the enrichment rules
 * in priority order, and moves the winners to PENDING_ENRICHMENT so the batch
 * worker can pick them up.
 *
 * Selecting and enriching are deliberately separate: this pass is cheap and
 * idempotent (it only moves rows between statuses), while enrichment costs
 * money. Keeping them apart means the queue can be reviewed — and trimmed —
 * before anything is spent.
 *
 * `dryRun` reports exactly what would be queued without writing.
 */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('enrichment.run');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: false, message: 'Supabase service key not configured.' }, { status: 200 });
  }

  let body: { dryRun?: boolean; trigger?: 'manual' | 'cron' } = {};
  try {
    body = await request.json();
  } catch {
    // no body — run with defaults
  }

  const startedAtMs = Date.now();
  const service = getServiceSupabase();
  const [{ config: policy }, { rules }] = await Promise.all([getEnrichmentPolicy(), getEnrichmentRules()]);

  // The global cap is what's left of today's budget, not the raw policy number
  // — otherwise a second run in the same day would queue a full day again.
  const enrichedToday = await getEnrichedTodayCount();
  const globalCap = policy.dailyCap > 0 ? Math.max(0, policy.dailyCap - enrichedToday) : Number.MAX_SAFE_INTEGER;

  if (globalCap === 0) {
    return NextResponse.json({
      ok: false,
      message: `Daily cap already reached (${enrichedToday}/${policy.dailyCap}). Nothing queued.`,
    });
  }

  // Candidates: idle records that aren't snoozed. Reading in pages because
  // PostgREST caps a response at 1000 rows.
  const candidates: PrioritizableRecord[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    for (let from = 0; from < 200_000; from += 1000) {
      const { data, error } = await service
        .from('canonical_projects')
        .select(
          'id, bu, vertical, country, icp_code, record_type, source_key, priority_score, priority_band, estimated_value, contact_email, created_at, status'
        )
        .in('status', ['RAW'])
        .or(`snoozed_until.is.null,snoozed_until.lte.${today}`)
        .range(from, from + 999);

      if (error) {
        const hint = /does not exist|schema cache/i.test(error.message)
          ? ' Run the lead_lifecycle and prioritisation migrations first.'
          : '';
        return NextResponse.json({ ok: false, message: `${error.message}.${hint}` }, { status: 200 });
      }

      const rows = (data ?? []) as unknown as PrioritizableRecord[];
      candidates.push(...rows);
      if (rows.length < 1000) break;
    }
  } catch (err) {
    return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : String(err) }, { status: 200 });
  }

  const result = selectForEnrichment(candidates, rules, globalCap);
  const byRule = result.selections.map((s) => ({
    ruleId: s.ruleId,
    ruleName: s.ruleName,
    count: s.recordIds.length,
    overflow: s.overflow,
  }));

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      message: `${result.selectedIds.length} record${result.selectedIds.length === 1 ? '' : 's'} would be queued (${result.deferred} deferred, ${result.unmatched} matched no rule).`,
      candidates: candidates.length,
      selected: result.selectedIds.length,
      deferred: result.deferred,
      unmatched: result.unmatched,
      globalCap: globalCap === Number.MAX_SAFE_INTEGER ? null : globalCap,
      byRule,
    });
  }

  // Move the winners, one statement per rule so `selected_by_rule` records
  // which rule claimed each record.
  let queued = 0;
  for (const selection of result.selections) {
    if (selection.recordIds.length === 0) continue;
    const res = await transitionMany(selection.recordIds, 'PENDING_ENRICHMENT', {
      from: 'RAW',
      patch: { selected_by_rule: selection.ruleId },
    });
    if (res.ok) queued += res.updated;
  }

  const durationMs = Date.now() - startedAtMs;
  try {
    await service.from('prioritisation_runs').insert({
      trigger: body.trigger ?? 'manual',
      triggered_by: auth.user.id,
      candidates: candidates.length,
      selected: queued,
      deferred: result.deferred,
      unmatched: result.unmatched,
      global_cap: globalCap === Number.MAX_SAFE_INTEGER ? null : globalCap,
      by_rule: byRule,
      status: 'completed',
      finished_at: new Date().toISOString(),
      duration_ms: durationMs,
    });
  } catch {
    // History is best-effort — never fail the selection over it.
  }

  return NextResponse.json({
    ok: true,
    message: `Queued ${queued} record${queued === 1 ? '' : 's'} for enrichment — ${result.deferred} deferred, ${result.unmatched} matched no rule.`,
    candidates: candidates.length,
    selected: queued,
    deferred: result.deferred,
    unmatched: result.unmatched,
    byRule,
    durationMs,
  });
}
