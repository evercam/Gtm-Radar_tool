import { NextRequest, NextResponse } from 'next/server';
import { checkPermission } from '@/lib/auth/session';
import { listRoles, getPermissionCatalog, createRole, updateRole, deleteRole } from '@/lib/auth/roleStore';

export const dynamic = 'force-dynamic';

/**
 * Role administration.
 *
 * Gated on `users.manage` — the same permission that lets someone change another
 * person's role, because defining a role and handing it out are the same power
 * wearing two hats. Every handler re-checks it server-side; the proxy's route
 * guard is optimistic and is not the boundary.
 *
 * Writes go through the service role: `app_roles` grants no write policy, for
 * the same reason `user_profiles` does not — a table that decides authorization
 * cannot be writable by the thing it authorizes.
 */

/** GET /api/roles — every role, plus the permissions that can be ticked. */
export async function GET() {
  const auth = await checkPermission('users.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const [{ roles, tableMissing }, permissions] = await Promise.all([listRoles(), getPermissionCatalog()]);
  return NextResponse.json({
    ok: true,
    roles,
    permissions,
    tableMissing,
    /*
      Named plainly so the UI can warn rather than mislead. A permission nothing
      reads is assignable and inert, and the person ticking it deserves to know
      that before they hand somebody a role they think grants something.
    */
    unenforced: permissions.filter((p) => !p.isEnforced).map((p) => p.name),
  });
}

/** POST /api/roles — define a new role. */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('users.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  let body: { name?: string; label?: string; description?: string; permissions?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON.' }, { status: 400 });
  }
  if (!body.name || !body.label) {
    return NextResponse.json({ ok: false, message: 'A name and a label are required.' }, { status: 400 });
  }

  const result = await createRole({
    name: body.name.trim().toLowerCase(),
    label: body.label,
    description: body.description,
    permissions: body.permissions ?? [],
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 200 });
}

/** PATCH /api/roles — change a role's label, description or permissions. */
export async function PATCH(request: NextRequest) {
  const auth = await checkPermission('users.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  let body: { name?: string; label?: string; description?: string; permissions?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON.' }, { status: 400 });
  }
  if (!body.name) return NextResponse.json({ ok: false, message: 'A role name is required.' }, { status: 400 });

  const result = await updateRole(body.name, {
    label: body.label,
    description: body.description,
    permissions: body.permissions,
  });
  return NextResponse.json(result);
}

/** DELETE /api/roles?name=… — remove a role nobody holds. */
export async function DELETE(request: NextRequest) {
  const auth = await checkPermission('users.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const name = request.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ ok: false, message: 'A role name is required.' }, { status: 400 });

  const result = await deleteRole(name);
  return NextResponse.json(result);
}
