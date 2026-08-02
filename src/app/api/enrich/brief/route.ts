import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getEnrichmentPolicy } from '@/lib/policies';
import { runEnrichment } from '@/lib/enrich/run';
import { isClaudeConfigured } from '@/lib/enrich/claude';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * How many records one invocation attempts.
 *
 * Small on purpose. The whole reason this route exists is that the research
 * call needs most of a 300-second function to itself; batching it would
 * recreate the problem it was split out of. Two, sequentially, with the last
 * one likely to be cut short — which is fine, because a record that misses its
 * brief today is picked up by the next run unchanged.
 */
const DEFAULT_LIMIT = 2;

interface BriefResult {
  id: string;
  name: string;
  ok: boolean;
  briefed: boolean;
  message?: string;
}

/**
 * POST /api/enrich/brief
 *
 * The second half of enrichment. `/api/enrich/batch` produces a WORKABLE lead —
 * domain, contacts, revealed addresses, all from Apollo, in about thirty
 * seconds. This produces a BRIEFED one: Claude's web research, the SDR
 * playbook, the account portfolio.
 *
 * They are split because they run on different clocks. Ten records at
 * concurrency three leaves each about seventy-five seconds of the batch route's
 * budget; the research call wants at least twice that and timed out on every
 * Cleveland-Cliffs record when it shared. Nothing downstream blocks on a brief,
 * so it is the half that can afford to wait.
 *
 * Picks records that already have a contact and no ICP score, oldest first, so
 * a lead a seller can already work is never held up by the part that only makes
 * it easier to open.
 */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('enrichment.run');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { ok: false, message: 'Supabase service key not configured — briefs are written back, so the service role is required.' },
      { status: 200 }
    );
  }
  if (!(await isClaudeConfigured())) {
    return NextResponse.json(
      { ok: false, message: 'No Anthropic key configured. The brief is entirely Claude — add one in Settings.' },
      { status: 200 }
    );
  }

  let body: { limit?: number; ids?: string[] } = {};
  try {
    body = await request.json();
  } catch {
    // no body — take the default slice off the queue
  }

  const { config: policy } = await getEnrichmentPolicy();
  if (!policy.engines.claude) {
    return NextResponse.json(
      { ok: true, briefed: 0, results: [], message: 'The Claude engine is off in the enrichment policy, so no briefs are generated.' },
      { status: 200 }
    );
  }

  const limit = Math.max(1, Math.min(body.limit ?? DEFAULT_LIMIT, 10));
  const service = getServiceSupabase();

  const columns =
    'id,canonical_name,record_type,icp_code,company_name_raw,contact_name,contact_email,contact_phone,description,city,state_province,country,estimated_value,estimated_value_currency,source_key,project_url,vertical,current_phase,construction_start_date,estimated_completion_date,announced_date,bid_date';

  let query = service.from('canonical_projects').select(columns);
  if (body.ids?.length) {
    query = query.in('id', body.ids);
  } else {
    // Enriched enough to be worth briefing, not yet briefed. Oldest first so a
    // record cannot sit unbriefed forever behind newer arrivals.
    query = query
      .not('enriched_at', 'is', null)
      .not('contact_email', 'is', null)
      .is('icp_fit_score', null)
      .order('enriched_at', { ascending: true });
  }

  const { data: rows, error } = await query.limit(limit);
  if (error) {
    return NextResponse.json({ ok: false, message: `Could not read the brief queue: ${error.message}` }, { status: 200 });
  }
  if (!rows?.length) {
    return NextResponse.json(
      { ok: true, briefed: 0, results: [], message: 'Nothing to brief — every enriched record already carries one.' },
      { status: 200 }
    );
  }

  // Research ON — the one place it is. Apollo stays enabled so the run can
  // still fill anything the fast pass left, and reveals it has already paid for
  // come back from the cache rather than being bought twice.
  const briefPolicy = { ...policy, researchInline: true };

  const results: BriefResult[] = [];
  let briefed = 0;

  // Sequential, deliberately. Two research calls at once would each get half
  // the function's remaining time and both would be cut short.
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    try {
      const res = await runEnrichment(row as never, briefPolicy, {
        claude: true,
        apollo: policy.engines.apollo,
        fillCommittee: false, // the committee was assembled by the fast pass
        maxApolloCalls: null,
        maxClaudeCalls: null,
        overridden: true,
      });
      // `engines.claude` is true only when the research call actually returned,
      // so this reports what landed rather than what was attempted.
      const didBrief = res.ok && res.engines.claude;
      if (didBrief) briefed++;
      results.push({
        id: String(row.id),
        name: String(row.canonical_name ?? ''),
        ok: res.ok,
        briefed: didBrief,
        message: res.message ?? undefined,
      });
    } catch (err) {
      results.push({
        id: String(row.id),
        name: String(row.canonical_name ?? ''),
        ok: false,
        briefed: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const short = results.length - briefed;
  return NextResponse.json({
    ok: true,
    briefed,
    results,
    message:
      `Briefed ${briefed} of ${results.length} record(s).` +
      (short > 0 ? ` ${short} did not complete their research and stay in the queue for the next run.` : ''),
  });
}
