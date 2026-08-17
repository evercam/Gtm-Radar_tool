import { NextRequest, NextResponse } from 'next/server';
import { checkPermission } from '@/lib/auth/session';
import { listConnections, revokeConnection } from '@/lib/auth/oauth/tokens';

export const dynamic = 'force-dynamic';

/**
 * Connected assistants — who has an OAuth connection to the MCP endpoint.
 *
 * NOT public, unlike its siblings under /api/oauth. Those exist so a client
 * holding no credential can obtain one; this one reads and revokes other
 * people's connections, so it is gated on `credentials.manage` like every other
 * key surface. Worth stating explicitly because the neighbouring paths are listed
 * in the proxy's PUBLIC_PATHS and it would be an easy mistake to add this one
 * alongside them.
 *
 * There is a real reason to want this visible. A static token is a credential
 * somebody deliberately minted; an OAuth connection appears whenever a colleague
 * approves a client, and without a list there is no way to answer "what is
 * connected to this workspace" short of querying the database.
 */

/** GET — every live connection. Never a token, only the fact of one. */
export async function GET() {
  const auth = await checkPermission('credentials.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const { connections, tableMissing } = await listConnections();
  return NextResponse.json({ ok: true, connections, tableMissing });
}

/**
 * DELETE — cuts one person's connection to one client.
 *
 * Both identifiers are required. Revoking by client alone would disconnect
 * everybody who happens to use the same assistant, which is almost never what
 * somebody clicking a single row intends.
 */
export async function DELETE(request: NextRequest) {
  const auth = await checkPermission('credentials.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  let body: { clientId?: string; userId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON.' }, { status: 400 });
  }

  if (!body.clientId || !body.userId) {
    return NextResponse.json({ ok: false, message: 'Both clientId and userId are required.' }, { status: 400 });
  }

  const result = await revokeConnection(body.clientId, body.userId);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
