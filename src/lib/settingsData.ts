import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';

function isPresent(value: string | null): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Server-only reads for the /settings page. Uses the service-role client
 * because `source_credentials` holds secrets — it must never be queried
 * with the anon client, and this module must never be imported from a
 * client component (the `server-only` import above throws a build error if
 * it is).
 */

export interface MaskedCredential {
  sourceKey: string;
  maskedApiKey: string | null; // e.g. "••••1234", or null if not set
  username: string | null; // not secret — shown as-is (only Barbour ABI uses this)
  hasPassword: boolean; // whether api_secret (e.g. Barbour ABI's password) is set, never the value itself
  baseUrl: string | null;
  isConfigured: boolean;
  lastTestedAt: string | null;
  lastTestResult: string | null;
}

interface SourceCredentialsRow {
  source_key: string;
  api_key: string | null;
  api_secret: string | null;
  username: string | null;
  base_url: string | null;
  is_configured: boolean;
  last_tested_at: string | null;
  last_test_result: string | null;
}

function mask(apiKey: string | null): string | null {
  if (!apiKey) return null;
  const last4 = apiKey.slice(-4);
  return `••••${last4}`;
}

/** Returns a map keyed by source_key. Never includes the raw api_key/api_secret. */
export async function getMaskedCredentials(): Promise<Record<string, MaskedCredential>> {
  if (!isSupabaseServiceConfigured()) return {};

  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from('source_credentials')
    .select('source_key, api_key, api_secret, username, base_url, is_configured, last_tested_at, last_test_result');

  if (error) throw new Error(`getMaskedCredentials: ${error.message}`);

  const map: Record<string, MaskedCredential> = {};
  for (const row of (data ?? []) as SourceCredentialsRow[]) {
    map[row.source_key] = {
      sourceKey: row.source_key,
      maskedApiKey: mask(row.api_key),
      username: row.username,
      hasPassword: isPresent(row.api_secret),
      baseUrl: row.base_url,
      isConfigured: row.is_configured,
      lastTestedAt: row.last_tested_at,
      lastTestResult: row.last_test_result,
    };
  }
  return map;
}
