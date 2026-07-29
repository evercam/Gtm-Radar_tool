import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { validateRules } from '@/lib/routing';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** POST /api/routing/save — persist admin routing rules to routing_policy. */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('routing.edit');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: false, message: 'Supabase not configured.' }, { status: 200 });
  }
  let body: { rules?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON.' }, { status: 400 });
  }
  const v = validateRules(body.rules);
  if (!v.ok) return NextResponse.json({ ok: false, message: v.error }, { status: 200 });

  const supabase = getServiceSupabase();
  const { error } = await supabase
    .from('routing_policy')
    .upsert({ id: 'default', rules: v.rules }, { onConflict: 'id' });
  if (error) {
    const hint = /schema cache|does not exist/i.test(error.message)
      ? ' Run the routing_policy migration (in supabase_setup.sql) first.'
      : '';
    return NextResponse.json({ ok: false, message: `Could not save: ${error.message}.${hint}` }, { status: 200 });
  }
  return NextResponse.json({ ok: true, message: `Saved ${v.rules.length} rules.` });
}
