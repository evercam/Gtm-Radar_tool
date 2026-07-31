import 'server-only';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { readSecret, writeSecret } from '@/lib/crypto/store';

/**
 * The session token.
 *
 * This token is INTERNAL. It was briefly shaped to be something PostgREST
 * would accept — signed with the project's shared JWT secret — but this
 * project signs with ES256 and publishes only the public half, so no such
 * secret exists and nothing here could ever mint a token PostgREST trusts.
 *
 * RLS is enforced instead by connecting to Postgres directly and setting the
 * same claim PostgREST would have set (see lib/db/pool.ts). That leaves this
 * token with exactly one job: proving to THIS app who the caller is. So it is
 * signed with a key the app owns and generates, and it never leaves for
 * anywhere that would try to validate it against Supabase.
 *
 * The claims still read `role: authenticated` and `aud: authenticated`. Not
 * decoration — `withUser` copies `sub` into `request.jwt.claims`, so the shape
 * the database sees is unchanged and the eighteen existing policies apply
 * untouched.
 *
 * Written against node:crypto rather than a JWT library: HS256 is an HMAC and
 * a comparison, the parsing is the security-sensitive part, and a dependency
 * here would be a dependency in the sign-in path.
 */

/** Claims Supabase's own tokens carry, and PostgREST reads. */
export interface SessionClaims {
  /** user_profiles.id — what auth.uid() resolves to. */
  sub: string;
  email?: string;
  /** Postgres role PostgREST switches to. Never anything but this. */
  role: 'authenticated';
  aud: 'authenticated';
  iss?: string;
  iat: number;
  exp: number;
}

export const SESSION_COOKIE = 'ldr_session';

/** Eight hours. Long enough for a working day, short enough that a stolen cookie expires. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/** Re-issued when less than this remains, so an active session never expires mid-task. */
export const SESSION_REFRESH_BEFORE_SECONDS = 60 * 60;

const b64url = (buf: Buffer) => buf.toString('base64url');
const enc = (obj: unknown) => b64url(Buffer.from(JSON.stringify(obj)));

function sign(data: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(data).digest());
}

/** Cached: every request verifies a token, and the key never changes mid-process. */
let secretCache: { value: string | null; at: number } | null = null;
const SECRET_TTL_MS = 60_000;

/** Guards against two concurrent sign-ins each generating a different key. */
let generating: Promise<string | null> | null = null;

/**
 * The signing key, generated on first use.
 *
 * Nothing to paste and nothing to look up: the key protects only this app's
 * own cookie, so the app is the right thing to choose it. 32 random bytes,
 * stored encrypted alongside every other secret. Rotating it is deleting it —
 * the next request makes a new one, and everyone signs in again.
 *
 * `SESSION_SIGNING_KEY` is read only when nothing is stored, and it is the one
 * env var left in the secret path. That is deliberate and it is not a hole in
 * the DB-only rule:
 *
 *   - It is not a vendor credential. Nothing is ever entered for it in
 *     Settings, so it cannot produce the failure the rule exists to prevent —
 *     a pasted key that appears to save while a stale variable keeps winning.
 *     The stored value takes precedence here precisely so that cannot happen.
 *   - Without it this module cannot be exercised without a live database, and
 *     the tampering tests in scripts/test-jwt.mjs are the difference between a
 *     forged cookie being rejected and it reading the whole lead book.
 */
export async function jwtSecret(): Promise<string | null> {
  if (secretCache && Date.now() - secretCache.at < SECRET_TTL_MS) return secretCache.value;

  const existing = await readSecret('session_signing_key');
  if (existing?.trim()) {
    secretCache = { value: existing.trim(), at: Date.now() };
    return secretCache.value;
  }

  const fromEnv = process.env.SESSION_SIGNING_KEY;
  if (fromEnv?.trim()) {
    secretCache = { value: fromEnv.trim(), at: Date.now() };
    return secretCache.value;
  }

  if (generating) return generating;
  generating = (async () => {
    const generated = randomBytes(32).toString('base64');
    const res = await writeSecret('session_signing_key', generated);
    // If it could not be stored, do NOT fall back to the in-memory value: it
    // would work until the next restart and then sign everyone out, which is
    // harder to diagnose than failing now.
    const value = res.ok ? generated : null;
    secretCache = { value, at: Date.now() };
    generating = null;
    return value;
  })();
  return generating;
}

/** Test hook — forces the next call to re-read. */
export function resetJwtSecretCache(): void {
  secretCache = null;
}

export async function issueSession(user: { id: string; email: string | null }): Promise<string | null> {
  const secret = await jwtSecret();
  if (!secret) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims: SessionClaims = {
    sub: user.id,
    email: user.email ?? undefined,
    role: 'authenticated',
    aud: 'authenticated',
    iss: process.env.NEXT_PUBLIC_SUPABASE_URL ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1` : undefined,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };

  const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}`;
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verifies a token and returns its claims, or null.
 *
 * Never throws and never explains: a caller that could distinguish "bad
 * signature" from "expired" from "malformed" would leak the difference to
 * anyone probing the cookie.
 */
export async function verifySession(token: string | undefined | null): Promise<SessionClaims | null> {
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const secret = await jwtSecret();
  if (!secret) return null;

  const [headerPart, payloadPart, signaturePart] = parts;

  const expected = Buffer.from(sign(`${headerPart}.${payloadPart}`, secret), 'base64url');
  const actual = Buffer.from(signaturePart, 'base64url');
  // Length must be checked separately: timingSafeEqual throws on a mismatch,
  // and a throw here is itself an oracle.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let header: { alg?: string };
  let claims: SessionClaims;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());
    claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
  } catch {
    return null;
  }

  // The alg is checked AFTER the signature, so 'none' never reaches a branch
  // that could accept it, and it is compared to a literal rather than trusted.
  if (header.alg !== 'HS256') return null;
  if (claims.role !== 'authenticated' || claims.aud !== 'authenticated') return null;
  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return null;

  return claims;
}

/** True once the token is close enough to expiry to be worth re-issuing. */
export function shouldRefresh(claims: SessionClaims): boolean {
  return claims.exp - Math.floor(Date.now() / 1000) < SESSION_REFRESH_BEFORE_SECONDS;
}

/** Cookie attributes. Shared so the set and the clear can never disagree. */
export function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    // Lax, not Strict: the sign-in is a top-level redirect back from Google,
    // and Strict would withhold the cookie on that first navigation.
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}

/** A random, URL-safe value for the OAuth `state` parameter. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}
