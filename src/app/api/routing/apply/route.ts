import { NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getRoutingPolicy, rerouteAll } from '@/lib/queries';
import { getScoringPolicies } from '@/lib/policies';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/routing/apply — score every record with the current scoring policy,
 * then materialize the routing rules onto it. Scoring runs first because rules
 * can lane on priority; both results are written in the same pass.
 */
export async function POST() {
  const auth = await checkPermission('routing.edit');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: false, message: 'Supabase service key not configured.' }, { status: 200 });
  }
  try {
    const [{ rules }, scoring] = await Promise.all([getRoutingPolicy(), getScoringPolicies()]);
    const res = await rerouteAll(rules, scoring);
    const p1 = res.byBand.P1 ?? 0;
    return NextResponse.json({
      ok: true,
      message: `Scored and routed ${res.total.toLocaleString()} records — ${p1.toLocaleString()} in P1.`,
      ...res,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /route|column|schema cache|does not exist/i.test(msg)
      ? ' Run the routing_columns migration first.'
      : '';
    return NextResponse.json({ ok: false, message: `${msg}.${hint}` }, { status: 200 });
  }
}
