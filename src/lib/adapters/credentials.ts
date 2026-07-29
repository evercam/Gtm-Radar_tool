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

export interface CredentialEnvFallback {
  /** e.g. 'BARBOUR_ABI_USERNAME' — only Barbour ABI's two-step login needs this. */
  usernameEnv?: string;
  /** e.g. 'BARBOUR_ABI_PASSWORD'. */
  apiSecretEnv?: string;
}

/**
 * Resolves an adapter's credentials with this precedence:
 *   1. the `source_credentials` row for this source_key (saved from /settings)
 *   2. env vars (BARBOUR_ABI_API_KEY / BARBOUR_ABI_BASE_URL, etc.)
 *
 * This lets a user configure keys from the UI without restarting the dev
 * server, while still working out-of-the-box for anyone who only set env
 * vars. Never throws — DB lookup failures silently fall back to env vars.
 */
export async function resolveCredentials(
  sourceKey: string,
  envApiKeyVar: string,
  envBaseUrlVar: string,
  defaultBaseUrl: string,
  envFallback?: CredentialEnvFallback
): Promise<ResolvedCredentials> {
  const envUsername = envFallback?.usernameEnv ? process.env[envFallback.usernameEnv] || null : null;
  const envApiSecret = envFallback?.apiSecretEnv ? process.env[envFallback.apiSecretEnv] || null : null;

  if (isSupabaseServiceConfigured()) {
    try {
      const supabase = getServiceSupabase();
      const { data } = await supabase
        .from('source_credentials')
        .select('api_key, api_secret, username, base_url')
        .eq('source_key', sourceKey)
        .maybeSingle();

      const row = data as SourceCredentialsRow | null;
      if (row?.api_key || row?.username) {
        return {
          // Stored secrets are AES-256-GCM envelopes. `readStored` also passes
          // through values written before encryption landed, so an existing
          // install keeps working until its next save re-writes them.
          apiKey: readStored(row.api_key) || process.env[envApiKeyVar] || null,
          apiSecret: readStored(row.api_secret) || envApiSecret,
          username: row.username || envUsername,
          baseUrl: row.base_url || process.env[envBaseUrlVar] || defaultBaseUrl,
        };
      }
    } catch {
      // Fall through to env vars below — DB unavailability should never break the adapter.
    }
  }

  return {
    apiKey: process.env[envApiKeyVar] || null,
    apiSecret: envApiSecret,
    username: envUsername,
    baseUrl: process.env[envBaseUrlVar] || defaultBaseUrl,
  };
}
