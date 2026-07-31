import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { SOURCE_SLUGS } from '@/lib/sourceSlugs';

/**
 * Server-side answer to "can this source run without the user pasting a key?"
 *
 * The adapters resolve credentials themselves from the encrypted
 * `source_credentials` row (see adapters/credentials.ts). What was missing is a
 * way for the CALLER to know that before it demands a key: the Search route
 * used to reject any request with an empty apiKey field, so a perfectly
 * configured source still had to be re-typed on every search.
 *
 * This must agree with `resolveCredentials` about what "configured" means, so
 * it reads the same row and consults nothing else. When it reported an `env`
 * origin the two could disagree, and the UI would offer a source that then
 * failed to authenticate.
 *
 * Reports only booleans — never a key, or any part of one.
 */

export interface CredentialStatus {
  /** Credentials resolve server-side, so the UI need not ask for a key. */
  configured: boolean;
  /** Where they came from — shown in the UI so it's clear what's in play. */
  origin: 'saved' | 'none';
  /** This source needs no credentials at all. */
  keyless: boolean;
}

/** Credential status for one slug. Never throws — a DB failure reads as unconfigured. */
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
      // A DB failure reads as unconfigured — see the note above on agreeing
      // with resolveCredentials rather than guessing more optimistically.
    }
  }

  return { configured: false, origin: 'none', keyless: false };
}

/** Credential status for every known slug — used by the Search page on load. */
export async function getAllCredentialStatuses(): Promise<Record<string, CredentialStatus>> {
  const entries = await Promise.all(
    Object.keys(SOURCE_SLUGS).map(async (slug) => [slug, await getCredentialStatus(slug)] as const)
  );
  return Object.fromEntries(entries);
}
