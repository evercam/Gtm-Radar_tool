import 'server-only';
import { headers } from 'next/headers';

/**
 * Recognising the scheduler.
 *
 * A cron caller has no cookies, so it authenticates with a shared secret in
 * the `x-cron-secret` header. Two layers need this answer — the permission
 * check in lib/auth/session, and the data layer in lib/supabase/server, which
 * must hand a verified scheduler the service client rather than the anonymous
 * one — so it lives in its own module to keep those two from importing each
 * other.
 *
 * This is the one secret still read from the environment rather than the
 * encrypted store: the scheduler has to authenticate before any database read
 * happens, so it cannot come from a table.
 */

/** Constant-time compare. A length-only or early-exit check leaks the secret a byte at a time. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * True when the current request carries a valid scheduler secret.
 *
 * Two headers carry it, because there are two hops. The external scheduler
 * hits /api/cron with `Authorization: Bearer <secret>`; that route then calls
 * the work endpoints internally with `x-cron-secret`. Both prove the same
 * thing, so both are accepted — recognising only the second left the cron
 * route itself reading as an anonymous user.
 */
export async function isCronRequest(): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim()) return false;

  try {
    const h = await headers();
    const internal = h.get('x-cron-secret');
    if (internal && secretMatches(internal, secret)) return true;

    const auth = h.get('authorization') ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    return bearer ? secretMatches(bearer, secret) : false;
  } catch {
    // Outside a request scope (build, script) there is no scheduler.
    return false;
  }
}

/** Compare a token taken from somewhere other than the header — same rules. */
export function isCronSecret(token: string | null | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret?.trim() || !token) return false;
  return secretMatches(token, secret);
}
