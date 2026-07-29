import 'server-only';
import { readSecret } from '@/lib/crypto/store';

/**
 * Matching a BDR on our roster to their Apollo user.
 *
 * The handoff spec asks for the contact owner to be the BDR's name. Apollo
 * takes an `owner_id`, not a name, so the roster's email is matched against
 * Apollo's users once and cached for the process — a lookup per contact would
 * be a request per lead.
 *
 * Matched on email, then on name. Email is exact and unambiguous; a name match
 * is a fallback for roster entries recorded without one, and is only accepted
 * when it is unique.
 */

const BASE = 'https://api.apollo.io';

export interface ApolloUser {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  /** Free text in Apollo — "Senior BDR", "Key Account Executive". */
  title?: string | null;
  prospect_territory_ids?: string[];
}

/** Territory ids resolved to names, so a roster entry can be derived from them. */
let territories: Map<string, string> | null = null;

async function loadTerritories(apiKey: string): Promise<Map<string, string>> {
  if (territories) return territories;
  const map = new Map<string, string>();
  try {
    const res = await fetch(`${BASE}/api/v1/prospect_territories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ page: 1, per_page: 100 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const rows = ((await res.json()) as { prospect_territories?: { id: string; name: string }[] })
        .prospect_territories ?? [];
      for (const t of rows) map.set(t.id, t.name);
    }
  } catch {
    // A missing territory list costs a suggestion, not the feature.
  }
  territories = map;
  return map;
}

/** The territory NAMES a user covers. Empty when they cover none. */
export async function territoriesFor(user: { prospect_territory_ids?: string[] }): Promise<string[]> {
  const apiKey = await readSecret('apollo_api_key');
  if (!apiKey) return [];
  const map = await loadTerritories(apiKey);
  return (user.prospect_territory_ids ?? []).map((id) => map.get(id)).filter((n): n is string => Boolean(n));
}

let users: ApolloUser[] | null = null;

export async function loadApolloUsers(force = false): Promise<ApolloUser[]> {
  if (force) territories = null;
  if (users && !force) return users;
  const apiKey = await readSecret('apollo_api_key');
  if (!apiKey) return [];

  try {
    const res = await fetch(`${BASE}/api/v1/users/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ page: 1, per_page: 100 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    users = ((await res.json()) as { users?: ApolloUser[] }).users ?? [];
    // Warm the territory names on the same pass — every caller that wants a
    // user wants to know where they work.
    await loadTerritories(apiKey);
    return users;
  } catch {
    return [];
  }
}

const fullName = (u: ApolloUser) => (u.name ?? `${u.first_name ?? ''} ${u.last_name ?? ''}`).trim().toLowerCase();

/** The Apollo user id for a roster entry, or null when there is no safe match. */
export async function findApolloUserId(email: string | null, name: string | null): Promise<string | null> {
  const all = await loadApolloUsers();
  if (all.length === 0) return null;

  if (email?.trim()) {
    const hit = all.find((u) => u.email?.toLowerCase() === email.trim().toLowerCase());
    if (hit?.id) return hit.id;
  }

  if (name?.trim()) {
    const wanted = name.trim().toLowerCase();
    const hits = all.filter((u) => fullName(u) === wanted);
    // Only a unique name match. Two people called the same thing means the
    // contact would be owned by whichever sorted first, which is not an answer.
    if (hits.length === 1 && hits[0].id) return hits[0].id;
  }

  return null;
}
