import 'server-only';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession, type SessionClaims } from './jwt';

/**
 * Reading the session cookie inside a request.
 *
 * Split from jwt.ts so the token functions stay free of `next/headers` and can
 * be exercised by the test scripts without a request scope.
 */

/** The verified claims for this request, or null. Never throws. */
export async function sessionClaims(): Promise<SessionClaims | null> {
  try {
    const store = await cookies();
    return await verifySession(store.get(SESSION_COOKIE)?.value);
  } catch {
    // Outside a request scope — a background job has no cookies.
    return null;
  }
}

/** The raw token, for handing to PostgREST as a bearer credential. */
export async function sessionToken(): Promise<string | null> {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    // Verified before use: an unsigned token must never reach the database,
    // where a forged `sub` would be taken at face value by every RLS policy.
    return (await verifySession(token)) ? token : null;
  } catch {
    return null;
  }
}
