import { NextResponse, type NextRequest } from 'next/server';
import { checkPermission } from '@/lib/auth/session';
import { saveAuthSettings } from '@/lib/auth/authSettings';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/settings — the domains allowed to sign in unattended.
 *
 * Gated on `users.manage`: deciding who may admit themselves is the same
 * decision as who may hold an account.
 */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('users.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  let body: { allowedDomains?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Body must be JSON.' }, { status: 400 });
  }

  return NextResponse.json(await saveAuthSettings(body.allowedDomains ?? []), { status: 200 });
}
