import { NextResponse } from 'next/server';
import { checkPermission } from '@/lib/auth/session';
import { exportConfigBundle, bundleFilename } from '@/lib/config/bundle';

export const dynamic = 'force-dynamic';

/**
 * GET /api/config/export — the current parameters, as one JSON file.
 *
 * Gated on `settings.manage`: the bundle contains routing logic, quotas,
 * budgets and the sign-in allow-list. It contains no credentials — API keys
 * live encrypted in `app_secrets` and are deliberately not gathered, so a
 * config file can be mailed, committed or diffed without leaking anything.
 */
export async function GET() {
  const auth = await checkPermission('settings.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const bundle = await exportConfigBundle(auth.user.email);

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${bundleFilename(bundle)}"`,
      // A configuration snapshot is a point in time; a cached copy would be
      // silently stale exactly when someone is comparing two of them.
      'Cache-Control': 'no-store',
    },
  });
}
