import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { decryptSecret, isEncrypted } from '@/lib/crypto/secrets';

/**
 * Reads a stored credential column. Values written since the encryption
 * migration are envelopes; anything older is still plaintext and is returned
 * as-is so an existing install keeps working. The next save encrypts it.
 */
function readStored(value: string | null): string | null {
  if (!value) return null;
  return isEncrypted(value) ? decryptSecret(value) : value;
}

export interface ResolvedCredentials {
  apiKey: string | null;
  apiSecret: string | null;
  username: string | null;
  baseUrl: string | null;
}

interface SourceCredentialsRow {
  api_key: string | null;
  api_secret: string | null;
  username: string | null;
  base_url: string | null;
}

/**
 * Resolves an adapter's credentials from the encrypted `source_credentials`
 * row for this source_key — the one Settings writes.
 *
 * The database is the only source. Environment variables were consulted as a
 * fallback until they were removed deliberately: a silent fallback means a key
 * can be live in production while Settings shows the source as unconfigured,
 * so rotating it from the UI appears to work and changes nothing, because the
 * stale variable keeps winning. `importEnvSourceCredentials` in
 * `lib/crypto/store.ts` is the one-way bridge for an install upgrading from
 * env vars; run `scripts/import-env-credentials.mjs` before deleting them.
 *
 * `baseUrl` still falls back — to the adapter's own `defaultBaseUrl` constant,
 * not to the environment. Only an install pointing at a sandbox endpoint needs
 * to override it, and that override belongs in the row alongside the key.
 *
 * Never throws. A DB failure resolves to no credentials, which each adapter
 * already reports as "not configured" — a clear failure rather than a
 * half-authenticated request against a live vendor API.
 */
export async function resolveCredentials(
  sourceKey: string,
  defaultBaseUrl: string
): Promise<ResolvedCredentials> {
  const unconfigured: ResolvedCredentials = {
    apiKey: null,
    apiSecret: null,
    username: null,
    baseUrl: defaultBaseUrl,
  };

  if (!isSupabaseServiceConfigured()) return unconfigured;

  try {
    const supabase = getServiceSupabase();
    const { data } = await supabase
      .from('source_credentials')
      .select('api_key, api_secret, username, base_url')
      .eq('source_key', sourceKey)
      .maybeSingle();

    const row = data as SourceCredentialsRow | null;
    if (!row) return unconfigured;

    return {
      // Stored secrets are AES-256-GCM envelopes. `readStored` also passes
      // through values written before encryption landed, so an existing
      // install keeps working until its next save re-writes them.
      apiKey: readStored(row.api_key),
      apiSecret: readStored(row.api_secret),
      username: row.username,
      baseUrl: row.base_url || defaultBaseUrl,
    };
  } catch {
    return unconfigured;
  }
}
