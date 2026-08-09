import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { checkPermission } from '@/lib/auth/session';
import { getRoles } from '@/lib/auth/roleStore';

export const dynamic = 'force-dynamic';

/**
 * User administration. Every handler re-checks `users.manage` server-side —
 * the proxy's route guard is optimistic and is not the boundary.
 *
 * Writes go through the service role because changing someone else's role is
 * deliberately impossible under RLS: `user_profiles` grants no policy for it.
 */

/** PATCH /api/users — change a role, scope, or active flag. */
export async function PATCH(request: NextRequest) {
  const auth = await checkPermission('users.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: false, message: 'Supabase service key not configured.' }, { status: 200 });
  }

  let body: {
    id?: string;
    role?: string;
    is_active?: boolean;
    bu?: string[];
    verticals?: string[];
    regions?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON.' }, { status: 400 });
  }

  if (!body.id) return NextResponse.json({ ok: false, message: 'A user id is required.' }, { status: 400 });
  /*
    Roles are rows now, so a role is valid because the table has it — not because
    it appears in a union in the source. Checked here as well as by the foreign
    key so the caller gets the list of real roles back instead of a constraint
    violation string.
  */
  if (body.role !== undefined) {
    const { roles } = await getRoles();
    if (!roles.some((r) => r.name === body.role)) {
      return NextResponse.json(
        { ok: false, message: `Role must be one of: ${roles.map((r) => r.name).join(', ')}.` },
        { status: 400 }
      );
    }
  }

  const service = getServiceSupabase();

  // Removing the last admin would lock everyone out of user management, keys
  // and rules, with no way back short of a SQL console. Refuse it — including
  // when an admin demotes or deactivates themselves.
  const losingAdmin = (body.role !== undefined && body.role !== 'admin') || body.is_active === false;
  if (losingAdmin) {
    const { data: target } = await service.from('user_profiles').select('role').eq('id', body.id).maybeSingle();
    if ((target as { role: string } | null)?.role === 'admin') {
      const { count } = await service
        .from('user_profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'admin')
        .eq('is_active', true);
      if ((count ?? 0) <= 1) {
        return NextResponse.json(
          { ok: false, message: 'This is the last active admin. Promote someone else first.' },
          { status: 200 }
        );
      }
    }
  }

  const patch: Record<string, unknown> = {};
  if (body.role !== undefined) patch.role = body.role;
  if (body.is_active !== undefined) patch.is_active = body.is_active;
  if (body.bu !== undefined) patch.bu = body.bu;
  if (body.verticals !== undefined) patch.verticals = body.verticals;
  if (body.regions !== undefined) patch.regions = body.regions;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, message: 'Nothing to update.' }, { status: 400 });
  }

  const { error } = await service.from('user_profiles').update(patch).eq('id', body.id);
  if (error) {
    const hint = /schema cache|does not exist/i.test(error.message) ? ' Run the auth_rbac migration first.' : '';
    return NextResponse.json({ ok: false, message: `${error.message}.${hint}` }, { status: 200 });
  }

  return NextResponse.json({ ok: true, message: 'User updated.' });
}

/**
 * POST /api/users — pre-authorise an address.
 *
 * There is no invitation to send any more: sign-in is Google, and nobody needs
 * a link or a password to use it. What an admin still needs is a way to say
 * "when this person arrives, they are a sales manager, not a BDR" — otherwise
 * the only way to grant a role is to wait for someone to sign in wrong and fix
 * it afterwards.
 *
 * So this writes the profile ahead of time. `admit_google_user` matches on
 * lower(email) and updates the row it finds rather than creating a second one,
 * so the role and scope set here survive first sign-in.
 */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('users.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: false, message: 'Supabase service key not configured.' }, { status: 200 });
  }

  let body: { email?: string; role?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON.' }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email) return NextResponse.json({ ok: false, message: 'An email address is required.' }, { status: 400 });
  /*
    Roles are rows now, so a role is valid because the table has it — not because
    it appears in a union in the source. Checked here as well as by the foreign
    key so the caller gets the list of real roles back instead of a constraint
    violation string.
  */
  if (body.role !== undefined) {
    const { roles } = await getRoles();
    if (!roles.some((r) => r.name === body.role)) {
      return NextResponse.json(
        { ok: false, message: `Role must be one of: ${roles.map((r) => r.name).join(', ')}.` },
        { status: 400 }
      );
    }
  }

  const service = getServiceSupabase();

  const { data: existing } = await service
    .from('user_profiles')
    .select('id, role')
    .ilike('email', email)
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; role: string };
    if (body.role && body.role !== row.role) {
      const { error } = await service.from('user_profiles').update({ role: body.role }).eq('id', row.id);
      if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 200 });
      return NextResponse.json({ ok: true, message: `${email} already had access — role changed to ${body.role}.` });
    }
    return NextResponse.json({ ok: true, message: `${email} already has access.` });
  }

  // Active from the start: an admin naming an address IS the approval, and
  // making them wait in the pending queue afterwards would be the same
  // decision asked twice.
  const { error } = await service.from('user_profiles').insert({
    email,
    full_name: email.split('@')[0],
    role: body.role ?? 'bdr',
    is_active: true,
  });

  if (error) {
    const hint = /does not exist|schema cache/i.test(error.message) ? ' Run the auth migrations first.' : '';
    return NextResponse.json({ ok: false, message: `${error.message}.${hint}` }, { status: 200 });
  }

  return NextResponse.json({
    ok: true,
    message: `${email} can now sign in with Google as ${body.role ?? 'bdr'}.`,
  });
}
