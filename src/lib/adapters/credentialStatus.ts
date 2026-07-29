import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { SOURCE_SLUGS, type SourceSlugInfo } from '@/lib/sourceSlugs';

/**
 * Server-side answer to "can this source run without the user pasting a key?"
 *
 * The adapters already resolve credentials themselves (source_credentials row
 * first, then env vars — see adapters/credentials.ts). What was missing is a
 * way for the CALLER to know that before it demands a key: the Search route
 * used to reject any request with an empty apiKey field, so a perfectly
 * configured source still had to be re-typed on every search.
 *
 * Reports only booleans — never a key, or any part of one.
 */

export interface CredentialStatus {
  /** Credentials resolve server-side, so the UI need not ask for a key. */
  configured: boolean;
  /** Where they came from — shown in the UI so it's clear what's in play. */
  origin: 'saved' | 'env' | 'none';
  /** This source needs no credentials at all. */
  keyless: boolean;
}

function envConfigured(info: SourceSlugInfo): boolean {
  const key = info.envApiKey ? process.env[info.envApiKey] : null;
  if (!key?.trim()) return false;
  if (info.needsUsername) {
    const user = info.envUsername ? process.env[info.envUsername] : null;
    const secret = info.envApiSecret ? process.env[info.envApiSecret] : null;
    return Boolean(user?.trim() && secret?.trim());
  }
  return true;
}

/** Credential status for one slug. Never throws — a DB failure reads as env-only. */
export async function getCredentialStatus(slug: string): Promise<CredentialStatus> {
  const info = SOURCE_SLUGS[slug];
  if (!info) return { configured: false, origin: 'none', keyless: false };
  if (info.keyless) return { configured: true, origin: 'none', keyless: true };

  if (isSupabaseServiceConfigured()) {
    try {
      const supabase = getServiceSupabase();
      const { data } = await supabase
        .from('source_credentials')
        .select('api_key, api_secret, username')
        .eq('source_key', info.sourceKey)
        .maybeSingle();
      const row = data as { api_key: string | null; api_secret: string | null; username: string | null } | null;
      if (row?.api_key?.trim()) {
        const complete = info.needsUsername ? Boolean(row.username?.trim() && row.api_secret?.trim()) : true;
        if (complete) return { configured: true, origin: 'saved', keyless: false };
      }
    } catch {
      // fall through to env
    }
  }

  return envConfigured(info)
    ? { configured: true, origin: 'env', keyless: false }
    : { configured: false, origin: 'none', keyless: false };
}

/** Credential status for every known slug — used by the Search page on load. */
export async function getAllCredentialStatuses(): Promise<Record<string, CredentialStatus>> {
  const entries = await Promise.all(
    Object.keys(SOURCE_SLUGS).map(async (slug) => [slug, await getCredentialStatus(slug)] as const)
  );
  return Object.fromEntries(entries);
}
