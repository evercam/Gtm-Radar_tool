import { NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getRoutingPolicy, rerouteAll, type ScoringScope } from '@/lib/queries';
import { getScoringPolicies } from '@/lib/policies';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/routing/apply — score records with the current scoring policy, then
 * materialize the routing rules onto them. Scoring runs first because rules can
 * lane on priority; both results are written in the same pass.
 *
 * Defaults to `scope: 'unscored'` — the records that arrived since the last run.
 * A full pass over 22,000 records takes 8–10 minutes against a 300-second
 * function limit, so as the only mode it could not complete in production, and
 * newly ingested records were never scored.
 *
 * `{ "scope": "all" }` forces the full rescore. That is genuinely required after
 * a POLICY change — new weights or band cut-offs make every stored score wrong —
 * and is best run somewhere without a request timeout.
 */
export async function POST(request: Request) {
  const auth = await checkPermission('routing.edit');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: false, message: 'Supabase service key not configured.' }, { status: 200 });
  }
  try {
    let body: { scope?: ScoringScope; maxRecords?: number } = {};
    try {
      body = await request.json();
    } catch {
      // no body — score what is unscored, which is the safe default
    }
    const scope: ScoringScope = body.scope === 'all' ? 'all' : 'unscored';

    const [{ rules }, scoring] = await Promise.all([getRoutingPolicy(), getScoringPolicies()]);
    const res = await rerouteAll(rules, scoring, { scope, maxRecords: body.maxRecords });
    const p1 = res.byBand.P1 ?? 0;

    const what = scope === 'all' ? 'every record' : 'newly ingested records';
    const message =
      res.total === 0
        ? 'Nothing to score — every record already carries a score.'
        : `Scored and routed ${res.total.toLocaleString()} ${what === 'every record' ? 'records' : 'new records'} — ${p1.toLocaleString()} in P1.` +
          (res.reachedCap ? ' Stopped at the per-run cap; run again to continue.' : '');

    return NextResponse.json({ ok: true, message, ...res });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /route|column|schema cache|does not exist/i.test(msg)
      ? ' Run the routing_columns migration first.'
      : '';
    return NextResponse.json({ ok: false, message: `${msg}.${hint}` }, { status: 200 });
  }
}
