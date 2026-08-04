import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { SOURCE_SLUGS, KEYED_SLUGS } from '@/lib/sourceSlugs';
import {
  activeKeyId,
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
 * The encrypted `app_secrets` row is the ONLY source on read. Environment
 * variables are a migration path, not a destination: `importEnvSecrets` copies
 * them into the encrypted table once, after which the variable can be deleted.
 *
 * They are deliberately no longer consulted when resolving a value. A silent
 * env fallback means a key can be live in production without appearing in
 * Settings, so rotating it from the UI looks like it worked and changes
 * nothing — the stale variable keeps winning. Import is therefore explicit and
 * one-way: `getSecretStatuses` still *detects* a value in the environment and
 * reports `origin: 'env'` so Settings can offer the import, but nothing reads
 * through to it.
 *
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
  github_token: {
    label: 'GitHub token',
    description:
      'Lets the Source Hub start the ConstructConnect collector. A browser cannot run in the deployment, so the work happens in GitHub Actions and this is what triggers it. Fine-grained token, this repository only, Actions: read and write',
    envVar: 'GITHUB_TOKEN',
    required: false,
  },
  cliq_webhook_url: {
    label: 'Zoho Cliq bot — export notices',
    description:
      'Posts who got how many leads when an export finishes. Apollo never notifies on contact creation, so without this a run that sent nothing looks identical to one nobody triggered. Paste the bot’s Incoming Webhook URL including its zapikey; leave empty to send nothing.',
    envVar: 'CLIQ_WEBHOOK_URL',
    required: false,
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
 * Resolves one secret's plaintext for server-side use from the encrypted
 * store. Returns null when it is not stored, or when the stored ciphertext
 * cannot be decrypted with any active key.
 *
 * An undecryptable row reads as absent rather than throwing: the caller's
 * "not configured" path is a far better failure than a 500 on every request,
 * and Settings reports the row as stale so it can be re-entered.
 */
export async function readSecret(key: AppSecretKey): Promise<string | null> {
  const { rows } = await loadRows();
  const row = rows.get(key);
  if (!row?.value_encrypted) return null;

  // A value written before the encryption migration is stored raw; accept it
  // so nothing breaks, and let the next save upgrade it.
  if (!isEncrypted(row.value_encrypted)) return row.value_encrypted;
  return decryptSecret(row.value_encrypted) || null;
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

/** Reads an env var, treating whitespace-only as absent. */
function envValue(name?: string): string | null {
  const raw = name ? process.env[name] : undefined;
  return raw && raw.trim() ? raw.trim() : null;
}

/**
 * One-time import of the four keyed adapters' credentials out of environment
 * variables and into the encrypted `source_credentials` table.
 *
 * The sibling of `importEnvSecrets` for per-source keys. `adapters/credentials`
 * no longer reads `process.env` at all, so this is the bridge an existing
 * install crosses once: it reads the legacy variables named in `SOURCE_SLUGS`,
 * encrypts the secret columns, and writes the row Settings would have written.
 *
 * A source that already stores an `api_key` is skipped, never overwritten. The
 * database is authoritative, so a forgotten variable must not be able to
 * clobber a key someone deliberately saved from the UI.
 *
 * Partial imports are allowed and reported: Barbour ABI needs a username and
 * password alongside its key, and importing the key alone leaves a row that
 * `getCredentialStatus` correctly reports as not configured. That is more
 * useful than refusing, because the missing halves are then visible in
 * Settings rather than hidden in a skipped-silently list.
 */
export async function importEnvSourceCredentials(): Promise<{
  imported: string[];
  skipped: string[];
  errors: string[];
}> {
  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  if (!isSupabaseServiceConfigured()) {
    return { imported, skipped, errors: ['Supabase service role is not configured.'] };
  }
  if (!isCryptoConfigured()) {
    return { imported, skipped, errors: ['No encryption key available — refusing to store a credential in plaintext.'] };
  }

  const service = getServiceSupabase();

  const configured = new Set<string>();
  try {
    const { data, error } = await service.from('source_credentials').select('source_key, api_key');
    if (error) {
      const hint = /does not exist|schema cache|relation/i.test(error.message)
        ? ' Run the source_credentials migration first.'
        : '';
      return { imported, skipped, errors: [`${error.message}.${hint}`] };
    }
    for (const row of (data ?? []) as { source_key: string; api_key: string | null }[]) {
      if (row.api_key?.trim()) configured.add(row.source_key);
    }
  } catch (err) {
    return { imported, skipped, errors: [err instanceof Error ? err.message : String(err)] };
  }

  for (const slug of KEYED_SLUGS) {
    const info = SOURCE_SLUGS[slug];

    if (configured.has(info.sourceKey)) {
      skipped.push(slug);
      continue;
    }

    const apiKey = envValue(info.envApiKey);
    const apiSecret = envValue(info.envApiSecret);
    const username = envValue(info.envUsername);
    const baseUrl = envValue(info.envBaseUrl);

    // Nothing in the environment for this source — not an error, just absent.
    if (!apiKey && !apiSecret && !username && !baseUrl) continue;

    const payload: Record<string, unknown> = {
      source_key: info.sourceKey,
      updated_at: new Date().toISOString(),
    };
    if (apiKey) {
      payload.api_key = encryptSecret(apiKey);
      payload.api_key_last4 = apiKey.slice(-4);
      payload.key_version = activeKeyId();
    }
    if (apiSecret) {
      payload.api_secret = encryptSecret(apiSecret);
      payload.api_secret_last4 = apiSecret.slice(-4);
      payload.key_version = activeKeyId();
    }
    if (username) payload.username = username;
    if (baseUrl) payload.base_url = baseUrl;

    try {
      const { error } = await service.from('source_credentials').upsert(payload, { onConflict: 'source_key' });
      if (error) {
        errors.push(`${slug}: ${error.message}`);
        continue;
      }
    } catch (err) {
      errors.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const missing = info.needsUsername
      ? [!apiKey ? 'key' : null, !username ? 'username' : null, !apiSecret ? 'password' : null].filter(Boolean)
      : [!apiKey ? 'key' : null].filter(Boolean);
    imported.push(missing.length ? `${slug} (still needs ${missing.join(' + ')})` : slug);
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
