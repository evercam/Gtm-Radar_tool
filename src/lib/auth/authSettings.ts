import 'server-only';
import { isSupabaseServiceConfigured, getServiceSupabase } from '@/lib/supabase/server';

/**
 * Which email domains may admit themselves.
 *
 * Relevant only because sign-in is open to Google: the button is public, so
 * without a list any Google account in the world would land a live profile.
 * An address whose domain is on the list is active on first sign-in; anything
 * else arrives inactive and waits for an admin. See the matching trigger in
 * 20260729100000_google_oauth — this list is enforced in the database, not
 * here, so bypassing the UI changes nothing.
 */

export interface AuthSettings {
  allowedDomains: string[];
  tableMissing: boolean;
}

/** Strips a leading '@', a scheme, a path, whitespace and case. */
export function normalizeDomain(input: string): string | null {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^@+/, '')
    .replace(/\/.*$/, '');
  // Someone pasting a whole address means the domain half of it.
  const domain = cleaned.includes('@') ? cleaned.split('@').pop()! : cleaned;
  if (!domain) return null;
  // A single label ("localhost", "evercam") is never a real email domain and
  // would silently admit nobody, which looks like the feature is broken.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null;
  return domain;
}

export function validateDomains(input: unknown): { ok: true; domains: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'Domains must be a list.' };

  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const domain = normalizeDomain(raw);
    if (!domain) return { ok: false, error: `"${raw.trim()}" is not a domain, e.g. evercam.com.` };
    if (!out.includes(domain)) out.push(domain);
  }
  return { ok: true, domains: out };
}

export async function getAuthSettings(): Promise<AuthSettings> {
  if (!isSupabaseServiceConfigured()) return { allowedDomains: [], tableMissing: false };

  const { data, error } = await getServiceSupabase()
    .from('auth_settings')
    .select('allowed_domains')
    .eq('id', 'default')
    .maybeSingle();

  if (error) {
    return { allowedDomains: [], tableMissing: /does not exist|schema cache/i.test(error.message) };
  }
  return {
    allowedDomains: ((data as { allowed_domains: string[] } | null)?.allowed_domains ?? []).slice().sort(),
    tableMissing: false,
  };
}

export async function saveAuthSettings(input: unknown): Promise<{ ok: boolean; message: string }> {
  if (!isSupabaseServiceConfigured()) return { ok: false, message: 'Supabase service role is not configured.' };

  const validated = validateDomains(input);
  if (!validated.ok) return { ok: false, message: validated.error };

  const { error } = await getServiceSupabase()
    .from('auth_settings')
    .upsert({ id: 'default', allowed_domains: validated.domains }, { onConflict: 'id' });

  if (error) {
    const hint = /schema cache|does not exist/i.test(error.message) ? ' Run the Google sign-in migration first.' : '';
    return { ok: false, message: `${error.message}.${hint}` };
  }

  return {
    ok: true,
    message:
      validated.domains.length === 0
        ? 'Saved. Every new account now waits for an admin to activate it.'
        : `Saved. New accounts from ${validated.domains.join(', ')} sign in without approval.`,
  };
}
