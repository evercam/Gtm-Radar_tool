import { NextResponse } from 'next/server';
import { getAllCredentialStatuses } from '@/lib/adapters/credentialStatus';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * GET /api/credentials/status
 *
 * Booleans only: which sources can run without the user pasting a key,
 * and whether that key came from /settings or from env. No secrets, not even
 * masked ones — the Search page uses this purely to decide whether to show a
 * key field or a "using saved key" badge.
 */
export async function GET() {
  const auth = await checkPermission('control.access');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  try {
    return NextResponse.json({ ok: true, statuses: await getAllCredentialStatuses() });
  } catch (err) {
    return NextResponse.json({ ok: false, statuses: {}, message: err instanceof Error ? err.message : String(err) });
  }
}
