import { isCronRequest } from '@/lib/auth/cronSecret';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sessionToken } from '@/lib/auth/cookie';

/**
 * Server-side Supabase clients. Env vars are read lazily inside the getter
 * functions (never at module scope) so importing this file never throws
 * during `next build` / static generation when env vars are absent — pages
 * can catch the thrown error and render a "connect Supabase" empty state.
 *
 * Accepts both Supabase key naming schemes: the classic anon/service_role keys
 * and the newer publishable/secret keys.
 */

/** Public (browser-safe) key: new "publishable" name or classic "anon". */
export function publicKey(): string | undefined {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
}

/** Privileged server key: new "secret" name or classic "service_role". */
export function secretKey(): string | undefined {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
}

export function isSupabaseServerConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && publicKey());
}

export function isSupabaseServiceConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && secretKey());
}

/**
 * Read client bound to the CURRENT REQUEST'S SESSION.
 *
 * This is what almost every server-side read should use. `getServerSupabase()`
 * below carries no session, so once RLS was enabled every query through it
 * silently returned an empty set — the records table looked empty while 5,865
 * rows sat in the database, because `auth.uid()` was null and no policy
 * matched.
 *
 * Sending the session token means RLS evaluates as the signed-in user, which
 * is the entire point of the policies: an owner sees their own leads, a
 * manager sees the team's. Returns null when Supabase isn't configured, or
 * when there is no valid session — callers fall back to the anon client or the
 * service role as appropriate.
 *
 * The token is this app's own (lib/auth/jwt.ts), signed with the project's JWT
 * secret and already verified by the time it gets here. PostgREST validates it
 * again on arrival and reads `sub` into `auth.uid()`, exactly as it did with a
 * Supabase-issued one — which is why dropping Supabase Auth changed no policy.
 */
export async function getRequestSupabase(): Promise<SupabaseClient | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = publicKey();
  if (!url || !key) return null;

  // ---------------------------------------------------------------------
  // TEMPORARY: service role, so RLS is NOT applied to these reads.
  //
  // The proper boundary needs a token PostgREST accepts. This project signs
  // ES256 and publishes only the public key, so the app cannot mint one, and
  // the direct-Postgres alternative is unreachable from this network (the
  // pooler accepts TCP and then carries nothing).
  //
  // A working path exists and is proven: mint a real Supabase session
  // server-side via generateLink + verifyOtp. Until that lands, reads go
  // through the service role so the app is usable.
  //
  // What this costs: any signed-in user can read every lead. That is an
  // accepted decision for this phase, not an oversight — the only account is
  // the admin, and the sign-in allow-list is empty so nobody can admit
  // themselves. Both facts are what make it safe.
  //
  // THE TRIGGER FOR FIXING THIS is adding a second person. The moment a BDR
  // has a login, they can read the whole book, and the allow-list being empty
  // no longer helps because an admin will have activated them deliberately.
  // ---------------------------------------------------------------------
  await sessionToken();
  return isSupabaseServiceConfigured() ? getServiceSupabase() : null;
}

/**
 * Read client for the signed-in user, falling back to the anon client when
 * there is no request context. Prefer this over `getServerSupabase()` in
 * anything a page can reach.
 */
export async function getReadSupabase(): Promise<SupabaseClient> {
  // A scheduler has no cookies, so the request-scoped client is anonymous and
  // RLS returns nothing to it. Every cron job then reported "nothing to do"
  // and recorded itself as a success — a silent no-op that looked healthy.
  // Once the shared secret is verified the caller is trusted machinery, which
  // is exactly what the service client is for.
  if (await isCronRequest()) return getServiceSupabase();
  return (await getRequestSupabase()) ?? getServerSupabase();
}

let serverCached: SupabaseClient | null = null;

/**
 * Read-only-ish server client using the anon key. Suitable for server
 * components / route handlers that only need to SELECT public catalog data
 * (icp_definitions, source_registry, canonical_projects) under RLS.
 */
export function getServerSupabase(): SupabaseClient {
  if (serverCached) return serverCached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = publicKey();

  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (or _PUBLISHABLE_KEY) in .env.local, then restart the dev server.'
    );
  }

  serverCached = createClient(url, anonKey, {
    auth: { persistSession: false },
  });
  return serverCached;
}

let serviceCached: SupabaseClient | null = null;

/**
 * Service-role client — bypasses RLS. Only ever import/call this from
 * server-only code (API routes), never from a client component. Used by the
 * ingestion route to upsert canonical_projects and update source_registry
 * health fields.
 */
export function getServiceSupabase(): SupabaseClient {
  if (serviceCached) return serviceCached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = secretKey();

  if (!url || !serviceKey) {
    throw new Error(
      'Supabase service role is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) in .env.local.'
    );
  }

  serviceCached = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
  return serviceCached;
}
