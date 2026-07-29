import { NextResponse, type NextRequest } from 'next/server';
import { checkPermission } from '@/lib/auth/session';
import { planImport, applyImport } from '@/lib/config/import';

export const dynamic = 'force-dynamic';

/**
 * POST /api/config/import — applies a configuration bundle.
 *
 * Dry run unless `apply: true` is sent explicitly. The default is the safe one
 * because this endpoint rewrites who gets which leads: a caller that forgets
 * the flag gets a report, not a changed workspace.
 */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('settings.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  let body: { bundle?: unknown; apply?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Body must be JSON.' }, { status: 400 });
  }

  if (!body.bundle) {
    return NextResponse.json({ ok: false, message: 'No configuration supplied.' }, { status: 400 });
  }

  if (!body.apply) {
    const plan = await planImport(body.bundle);
    return NextResponse.json({ ...plan, dryRun: true, message: plan.ok ? 'Nothing applied — this was a dry run.' : plan.error }, { status: 200 });
  }

  const result = await applyImport(body.bundle);
  return NextResponse.json({ ...result, dryRun: false }, { status: 200 });
}
