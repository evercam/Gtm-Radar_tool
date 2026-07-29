import { NextRequest, NextResponse } from 'next/server';
import { checkPermission } from '@/lib/auth/session';
import { writeSecret, importEnvSecrets, reEncryptAll, APP_SECRETS, type AppSecretKey } from '@/lib/crypto/store';

export const dynamic = 'force-dynamic';

/**
 * Platform secret management. Admin-only, and write-only by design: there is
 * no GET that returns a key. Settings reads status through
 * `getSecretStatuses`, which never includes key material.
 */

/** POST /api/secrets — save one secret, or run an import / re-encrypt pass. */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('credentials.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  let body: { action?: 'save' | 'import' | 'reencrypt'; key?: string; value?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON.' }, { status: 400 });
  }

  const action = body.action ?? 'save';

  if (action === 'import') {
    const res = await importEnvSecrets(auth.user.id);
    const parts = [
      res.imported.length ? `Imported ${res.imported.join(', ')}` : null,
      res.skipped.length ? `${res.skipped.length} already stored` : null,
      res.errors.length ? res.errors.join('; ') : null,
    ].filter(Boolean);
    return NextResponse.json({
      ok: res.errors.length === 0,
      message: parts.length ? parts.join(' · ') : 'Nothing to import — no keys found in the environment.',
    });
  }

  if (action === 'reencrypt') {
    const res = await reEncryptAll(auth.user.id);
    return NextResponse.json({
      ok: res.failed === 0,
      message: `Re-encrypted ${res.rotated}, already current ${res.skipped}${res.failed ? `, failed ${res.failed}` : ''}.`,
    });
  }

  const key = body.key as AppSecretKey | undefined;
  if (!key || !(key in APP_SECRETS)) {
    return NextResponse.json({ ok: false, message: 'Unknown secret.' }, { status: 400 });
  }

  const res = await writeSecret(key, body.value ?? '', auth.user.id);
  return NextResponse.json(res, { status: 200 });
}
