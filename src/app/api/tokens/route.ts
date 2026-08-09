import { NextRequest, NextResponse } from 'next/server';
import { checkPermission } from '@/lib/auth/session';
import { createToken, listTokens, revokeToken } from '@/lib/auth/apiTokens';
import { getRoles } from '@/lib/auth/roleStore';

export const dynamic = 'force-dynamic';

/**
 * API tokens for the MCP endpoint.
 *
 * Gated on `credentials.manage` — the same permission as any other key, because
 * that is what a token is. It grants whatever its role grants, so minting one is
 * exactly as consequential as handing somebody that role.
 */

/** GET /api/tokens — the tokens, never their secrets. */
export async function GET() {
  const auth = await checkPermission('credentials.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const [{ tokens, tableMissing }, { roles }] = await Promise.all([listTokens(), getRoles()]);
  return NextResponse.json({
    ok: true,
    tokens,
    tableMissing,
    roles: roles.map((r) => ({ name: r.name, label: r.label })),
  });
}

/** POST /api/tokens — mint one. The secret is in the response and nowhere else. */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('credentials.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  let body: { name?: string; role?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON.' }, { status: 400 });
  }
  if (!body.name?.trim()) return NextResponse.json({ ok: false, message: 'A token needs a name.' }, { status: 400 });
  if (!body.role) return NextResponse.json({ ok: false, message: 'A token needs a role.' }, { status: 400 });

  const { roles } = await getRoles();
  if (!roles.some((r) => r.name === body.role)) {
    return NextResponse.json(
      { ok: false, message: `Role must be one of: ${roles.map((r) => r.name).join(', ')}.` },
      { status: 400 }
    );
  }

  const result = await createToken({ name: body.name, role: body.role, createdBy: auth.user.id });
  return NextResponse.json(result);
}

/** DELETE /api/tokens?id=… — revoke, keeping the row for the audit trail. */
export async function DELETE(request: NextRequest) {
  const auth = await checkPermission('credentials.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const id = request.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, message: 'A token id is required.' }, { status: 400 });
  return NextResponse.json(await revokeToken(id));
}
