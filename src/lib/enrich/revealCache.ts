import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';

/**
 * What Apollo said about a person, so it is asked once rather than once per
 * record that mentions them.
 *
 * A reveal costs a credit and returns the same answer every time. Four
 * Cleveland-Cliffs mining records each revealed the same three people — twelve
 * credits for three addresses — and that is the shape of the problem, not an
 * outlier: it scales with how many projects a company has.
 *
 * Never throws. A cache that is unavailable must degrade to "no hit", which
 * costs credits; a cache that fails the run costs the whole record.
 */

export interface RevealedPerson {
  email: string | null;
  fullName: string | null;
  phone: string | null;
  linkedinUrl: string | null;
}

/**
 * How long an entry is trusted. People change jobs, and a stale address is
 * worse than a fresh miss because a seller writes to it and hears nothing.
 */
const TTL_DAYS = Number(process.env.APOLLO_REVEAL_TTL_DAYS) || 90;

export async function readRevealCache(personIds: string[]): Promise<Map<string, RevealedPerson>> {
  const out = new Map<string, RevealedPerson>();
  if (personIds.length === 0 || !isSupabaseServiceConfigured()) return out;

  const cutoff = new Date(Date.now() - TTL_DAYS * 86_400_000).toISOString();

  try {
    const service = getServiceSupabase();
    // Chunked: the ids travel in the URL on a GET, and a long list overruns what
    // PostgREST accepts — the request fails, the error is easy to swallow, and
    // the result reads as "nothing cached" while every credit is spent again.
    const CHUNK = 100;
    for (let i = 0; i < personIds.length; i += CHUNK) {
      const { data, error } = await service
        .from('apollo_reveal_cache')
        .select('apollo_person_id, email, full_name, phone, linkedin_url')
        .gte('revealed_at', cutoff)
        .in('apollo_person_id', personIds.slice(i, i + CHUNK));
      if (error) {
        console.warn(`Reveal cache read failed: ${error.message}`);
        return out;
      }
      for (const r of (data ?? []) as Record<string, string | null>[]) {
        out.set(r.apollo_person_id as string, {
          email: r.email,
          fullName: r.full_name,
          phone: r.phone,
          linkedinUrl: r.linkedin_url,
        });
      }
    }
  } catch (err) {
    console.warn(`Reveal cache unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  return out;
}

/**
 * Store one reveal, INCLUDING a null address.
 *
 * "Apollo has nobody for this id" is a real answer that cost a credit to learn.
 * Not recording it means paying to learn it again on the next record, which is
 * the same waste as not caching a hit.
 */
export async function writeRevealCache(
  personId: string,
  person: RevealedPerson,
  domain: string | null
): Promise<void> {
  if (!isSupabaseServiceConfigured()) return;
  try {
    const service = getServiceSupabase();
    const { error } = await service.from('apollo_reveal_cache').upsert(
      {
        apollo_person_id: personId,
        email: person.email,
        full_name: person.fullName,
        phone: person.phone,
        linkedin_url: person.linkedinUrl,
        domain,
        revealed_at: new Date().toISOString(),
      },
      { onConflict: 'apollo_person_id' }
    );
    if (error) console.warn(`Reveal cache write failed: ${error.message}`);
  } catch (err) {
    console.warn(`Reveal cache write threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
