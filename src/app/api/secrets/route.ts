import { NextRequest, NextResponse } from 'next/server';
import { checkPermission } from '@/lib/auth/session';
import {
  writeSecret,
  importEnvSecrets,
  importEnvSourceCredentials,
  reEncryptAll,
  APP_SECRETS,
  type AppSecretKey,
} from '@/lib/crypto/store';

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
    // Two separate stores, both fed from environment variables on an upgrade:
    // platform keys in `app_secrets` and the four keyed adapters in
    // `source_credentials`. One button has to clear both, or a user who sees
    // "imported" still has an adapter resolving from a variable it can no
    // longer read.
    const [secrets, sources] = await Promise.all([importEnvSecrets(auth.user.id), importEnvSourceCredentials()]);

    const imported = [...secrets.imported, ...sources.imported];
    const errors = [...secrets.errors, ...sources.errors];
    const skipped = secrets.skipped.length + sources.skipped.length;

    const parts = [
      imported.length ? `Imported ${imported.join(', ')}` : null,
      skipped ? `${skipped} already stored` : null,
      errors.length ? errors.join('; ') : null,
    ].filter(Boolean);

    return NextResponse.json({
      ok: errors.length === 0,
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
