import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  isCryptoConfigured,
  needsReEncryption,
  maskSecret,
} from './secrets';

/**
 * The one place platform-wide secrets are read and written.
 *
 * Precedence on read:
 *   1. the encrypted `app_secrets` row  (what Settings writes)
 *   2. the legacy environment variable  (so an existing install keeps working)
 *
 * Env vars are a migration path, not a destination: `importEnvSecrets` copies
 * them into the encrypted table once, after which the variable can be deleted.
 * Nothing here ever returns a secret to the browser — callers are server-side
 * adapters, and Settings only ever receives the `SecretStatus` shape.
 */

/** Every platform secret the app knows about. */
export const APP_SECRETS = {
  anthropic_api_key: {
    label: 'Anthropic (Claude)',
    description: 'Account identification, news mining and call-prep generation',
    envVar: 'ANTHROPIC_API_KEY',
    required: true,
  },
  apollo_api_key: {
    label: 'Apollo.io',
    description: 'Verified contacts and daily contact export',
    envVar: 'APOLLO_API_KEY',
    required: true,
  },
  hunter_api_key: {
    label: 'Hunter.io',
    description: 'Email verification — falls back to format + MX checks',
    envVar: 'HUNTER_API_KEY',
    required: false,
  },
  socrata_app_token: {
    label: 'Socrata (NYC & Chicago permits)',
    description: 'Free and self-serve — lifts the permit feeds from a shared-IP throttle to 1,000 requests/hour',
    envVar: 'SOCRATA_APP_TOKEN',
    required: false,
  },
  twilio_auth_token: {
    label: 'Twilio',
    description: 'Phone validation — falls back to format checks',
    envVar: 'TWILIO_AUTH_TOKEN',
    required: false,
  },
  google_client_id: {
    label: 'Google OAuth — client ID',
    description: 'Sign-in. From the Google Cloud console; not a secret, but kept with its pair',
    envVar: 'GOOGLE_CLIENT_ID',
    required: true,
  },
  google_client_secret: {
    label: 'Google OAuth — client secret',
    description: 'Sign-in. Exchanges the one-time code for the account identity',
    envVar: 'GOOGLE_CLIENT_SECRET',
    required: true,
  },
  session_signing_key: {
    label: 'Session signing key',
    description:
      'Signs this app’s own session cookie. Generated automatically on first sign-in — there is nothing to paste. Replacing it signs everyone out.',
    envVar: 'SESSION_SIGNING_KEY',
    required: false,
  },
} as const;

export type AppSecretKey = keyof typeof APP_SECRETS;

export interface SecretStatus {
  key: AppSecretKey;
  label: string;
  description: string;
  required: boolean;
  isSet: boolean;
  /** Where the value resolved from — 'env' means it still needs importing. */
  origin: 'database' | 'env' | 'none';
  /** Last four characters only. Never the key. */
  last4: string | null;
  /** True when the stored ciphertext predates the active encryption key. */
  stale: boolean;
  updatedAt: string | null;
}

interface SecretRow {
  key: string;
  value_encrypted: string | null;
  key_version: string | null;
  last4: string | null;
  updated_at: string;
}

async function loadRows(): Promise<{ rows: Map<string, SecretRow>; tableMissing: boolean }> {
  const rows = new Map<string, SecretRow>();
  if (!isSupabaseServiceConfigured()) return { rows, tableMissing: false };

  try {
    const { data, error } = await getServiceSupabase()
      .from('app_secrets')
      .select('key, value_encrypted, key_version, last4, updated_at');
    if (error) {
      return { rows, tableMissing: /does not exist|schema cache|relation/i.test(error.message) };
    }
    for (const r of (data ?? []) as SecretRow[]) rows.set(r.key, r);
    return { rows, tableMissing: false };
  } catch {
    return { rows, tableMissing: true };
  }
}

/**
 * Resolves one secret's plaintext for server-side use, database first then the
 * legacy env var. Returns null when neither has it.
 */
export async function readSecret(key: AppSecretKey): Promise<string | null> {
  const { rows } = await loadRows();
  const row = rows.get(key);

  if (row?.value_encrypted) {
    // A value written before the encryption migration is stored raw; accept it
    // so nothing breaks, and let the next save upgrade it.
    if (!isEncrypted(row.value_encrypted)) return row.value_encrypted;
    const plain = decryptSecret(row.value_encrypted);
    if (plain) return plain;
    // Undecryptable (wrong master key) — fall through to env rather than
    // failing the request outright.
  }

  const env = process.env[APP_SECRETS[key].envVar];
  return env && env.trim() ? env.trim() : null;
}

/** Encrypts and stores a secret. Pass an empty string to clear it. */
export async function writeSecret(
  key: AppSecretKey,
  plaintext: string,
  updatedBy?: string
): Promise<{ ok: boolean; message: string }> {
  if (!isSupabaseServiceConfigured()) {
    return { ok: false, message: 'Supabase service role is not configured.' };
  }
  if (!isCryptoConfigured()) {
    return { ok: false, message: 'No encryption key available — cannot store secrets safely.' };
  }

  const service = getServiceSupabase();
  const value = plaintext.trim();

  if (!value) {
    const { error } = await service.from('app_secrets').delete().eq('key', key);
    return error ? { ok: false, message: error.message } : { ok: true, message: `${APP_SECRETS[key].label} cleared.` };
  }

  try {
    const envelope = encryptSecret(value);
    const { error } = await service.from('app_secrets').upsert(
      {
        key,
        value_encrypted: envelope,
        key_version: envelope.split(':')[1],
        last4: value.slice(-4),
        updated_by: updatedBy ?? null,
      },
      { onConflict: 'key' }
    );
    if (error) {
      const hint = /schema cache|does not exist/i.test(error.message)
        ? ' Run the encrypted_secrets migration first.'
        : '';
      return { ok: false, message: `${error.message}.${hint}` };
    }
    return { ok: true, message: `${APP_SECRETS[key].label} saved and encrypted.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Status of every platform secret, for Settings. Contains no key material. */
export async function getSecretStatuses(): Promise<{ statuses: SecretStatus[]; tableMissing: boolean }> {
  const { rows, tableMissing } = await loadRows();

  const statuses = (Object.keys(APP_SECRETS) as AppSecretKey[]).map((key) => {
    const meta = APP_SECRETS[key];
    const row = rows.get(key);
    const envValue = process.env[meta.envVar];
    const inEnv = Boolean(envValue && envValue.trim());

    if (row?.value_encrypted) {
      return {
        key,
        label: meta.label,
        description: meta.description,
        required: meta.required,
        isSet: true,
        origin: 'database' as const,
        last4: row.last4 ?? maskSecret(decryptSecret(row.value_encrypted)),
        stale: needsReEncryption(row.value_encrypted),
        updatedAt: row.updated_at,
      };
    }

    return {
      key,
      label: meta.label,
      description: meta.description,
      required: meta.required,
      isSet: inEnv,
      origin: inEnv ? ('env' as const) : ('none' as const),
      last4: inEnv ? `••••${envValue!.trim().slice(-4)}` : null,
      stale: false,
      updatedAt: null,
    };
  });

  return { statuses, tableMissing };
}

/**
 * One-time import of any secret still living in an environment variable into
 * the encrypted table, so the variable can be removed.
 */
export async function importEnvSecrets(
  updatedBy?: string
): Promise<{ imported: string[]; skipped: string[]; errors: string[] }> {
  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  const { rows } = await loadRows();

  for (const key of Object.keys(APP_SECRETS) as AppSecretKey[]) {
    if (rows.get(key)?.value_encrypted) {
      skipped.push(APP_SECRETS[key].label);
      continue;
    }
    const envValue = process.env[APP_SECRETS[key].envVar];
    if (!envValue?.trim()) continue;

    const res = await writeSecret(key, envValue.trim(), updatedBy);
    if (res.ok) imported.push(APP_SECRETS[key].label);
    else errors.push(`${APP_SECRETS[key].label}: ${res.message}`);
  }

  return { imported, skipped, errors };
}

/**
 * Re-encrypts every stored secret with the active key. Safe to run repeatedly
 * and safe to interrupt: each row is independent, and rows already on the
 * current key are skipped.
 */
export async function reEncryptAll(updatedBy?: string): Promise<{ rotated: number; skipped: number; failed: number }> {
  let rotated = 0;
  let skipped = 0;
  let failed = 0;

  if (!isSupabaseServiceConfigured() || !isCryptoConfigured()) return { rotated, skipped, failed };

  const service = getServiceSupabase();
  const { rows } = await loadRows();

  for (const [key, row] of rows) {
    if (!row.value_encrypted) continue;
    if (!needsReEncryption(row.value_encrypted)) {
      skipped += 1;
      continue;
    }
    const plain = isEncrypted(row.value_encrypted) ? decryptSecret(row.value_encrypted) : row.value_encrypted;
    if (!plain) {
      failed += 1;
      continue;
    }
    try {
      const envelope = encryptSecret(plain);
      const { error } = await service
        .from('app_secrets')
        .update({
          value_encrypted: envelope,
          key_version: envelope.split(':')[1],
          last4: plain.slice(-4),
          updated_by: updatedBy ?? null,
        })
        .eq('key', key);
      if (error) failed += 1;
      else rotated += 1;
    } catch {
      failed += 1;
    }
  }

  // Per-source credentials share the same envelope format.
  try {
    const { data } = await service.from('source_credentials').select('source_key, api_key, api_secret');
    for (const r of (data ?? []) as { source_key: string; api_key: string | null; api_secret: string | null }[]) {
      const patch: Record<string, unknown> = {};

      for (const field of ['api_key', 'api_secret'] as const) {
        const current = r[field];
        if (!current || !needsReEncryption(current)) continue;
        const plain = isEncrypted(current) ? decryptSecret(current) : current;
        if (!plain) {
          failed += 1;
          continue;
        }
        patch[field] = encryptSecret(plain);
        patch[`${field}_last4`] = plain.slice(-4);
      }

      if (Object.keys(patch).length === 0) continue;
      patch.key_version = (patch.api_key ?? (patch.api_secret as string)).toString().split(':')[1];

      const { error } = await service.from('source_credentials').update(patch).eq('source_key', r.source_key);
      if (error) failed += 1;
      else rotated += 1;
    }
  } catch {
    // source_credentials may not exist yet — the app_secrets pass still counts.
  }

  return { rotated, skipped, failed };
}
