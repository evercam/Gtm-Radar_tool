import 'server-only';
import { createPublicKey, createVerify } from 'node:crypto';
import { readSecret } from '@/lib/crypto/store';

/**
 * Google OAuth, spoken directly.
 *
 * Supabase Auth used to broker this. Doing it here costs one redirect, one
 * token exchange and one signature check, and in return the app owns its own
 * identity: no second user store to keep in step with `user_profiles`, and the
 * only account records that exist are the ones this application created.
 *
 * The client ID and secret live in the encrypted `app_secrets` table like every
 * other credential — Settings, not the environment.
 */

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  sub: string;
}

export async function googleCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
  const [clientId, clientSecret] = await Promise.all([
    readSecret('google_client_id'),
    readSecret('google_client_secret'),
  ]);
  if (!clientId?.trim() || !clientSecret?.trim()) return null;
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

export async function isGoogleConfigured(): Promise<boolean> {
  return (await googleCredentials()) !== null;
}

/** Where this install receives the redirect. Derived, never configured twice. */
export function redirectUri(origin: string): string {
  return `${origin}/api/auth/google/callback`;
}

export function authorizeUrl(opts: {
  clientId: string;
  origin: string;
  state: string;
  /** Ties the returned id_token to this browser — see the callback. */
  nonce: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: redirectUri(opts.origin),
    response_type: 'code',
    scope: 'openid email profile',
    state: opts.state,
    nonce: opts.nonce,
    // Ask every time rather than silently reusing a Google session: this is an
    // internal tool, and "which account am I signed in as" should be explicit.
    prompt: 'select_account',
  });
  return `${AUTHORIZE}?${params}`;
}

interface Jwk {
  kid: string;
  n: string;
  e: string;
  alg?: string;
  kty: string;
}

let jwksCache: { keys: Jwk[]; at: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function jwks(force = false): Promise<Jwk[]> {
  if (jwksCache && !force && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(JWKS, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return jwksCache?.keys ?? [];
  const keys = ((await res.json()) as { keys?: Jwk[] }).keys ?? [];
  jwksCache = { keys, at: Date.now() };
  return keys;
}

/**
 * Verifies an id_token's RS256 signature against Google's published keys.
 *
 * The token arrived over TLS from a direct server-to-server call, so OIDC
 * permits skipping this. It is done anyway: the whole of authentication rests
 * on this one value, and Google rotates keys often enough that a stale cache is
 * the realistic failure — hence the single forced refetch on an unknown `kid`.
 */
async function verifyIdTokenSignature(token: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { kid?: string; alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  let keys = await jwks();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await jwks(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return null;

  try {
    const key = createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: 'jwk' } as never);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerPart}.${payloadPart}`);
    verifier.end();
    if (!verifier.verify(key, Buffer.from(signaturePart, 'base64url'))) return null;
  } catch {
    return null;
  }

  return payload;
}

/**
 * Exchanges the one-time code for the signed-in identity.
 *
 * Returns a reason rather than throwing, because every one of these failures
 * is something the sign-in page has to be able to say out loud.
 */
export async function exchangeCode(opts: {
  code: string;
  origin: string;
  nonce: string;
}): Promise<{ ok: true; identity: GoogleIdentity } | { ok: false; reason: string }> {
  const creds = await googleCredentials();
  if (!creds) return { ok: false, reason: 'not_configured' };

  let res: Response;
  try {
    res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: opts.code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri(opts.origin),
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }

  if (!res.ok) {
    // A mismatched redirect_uri lands here, and it is by far the most common
    // setup mistake — worth telling apart from a generic refusal.
    const body = await res.text().catch(() => '');
    return { ok: false, reason: /redirect_uri_mismatch/i.test(body) ? 'redirect_mismatch' : 'exchange_failed' };
  }

  const token = ((await res.json()) as { id_token?: string }).id_token;
  if (!token) return { ok: false, reason: 'no_id_token' };

  const payload = await verifyIdTokenSignature(token);
  if (!payload) return { ok: false, reason: 'bad_signature' };

  const now = Math.floor(Date.now() / 1000);
  const aud = payload.aud;
  const iss = payload.iss;
  const exp = payload.exp;

  if (typeof aud !== 'string' || aud !== creds.clientId) return { ok: false, reason: 'wrong_audience' };
  if (typeof iss !== 'string' || !ISSUERS.includes(iss)) return { ok: false, reason: 'wrong_issuer' };
  if (typeof exp !== 'number' || exp <= now) return { ok: false, reason: 'expired' };
  // Binds this token to the browser that started the flow: without it, a token
  // obtained elsewhere could be replayed into this callback.
  if (payload.nonce !== opts.nonce) return { ok: false, reason: 'nonce_mismatch' };

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email) return { ok: false, reason: 'no_email' };
  // Google sets this false for addresses it has not confirmed the holder owns.
  // Admitting one would let anyone claim a colleague's address.
  if (payload.email_verified !== true) return { ok: false, reason: 'unverified_email' };

  return {
    ok: true,
    identity: {
      email,
      emailVerified: true,
      name: typeof payload.name === 'string' ? payload.name : null,
      picture: typeof payload.picture === 'string' ? payload.picture : null,
      sub: String(payload.sub ?? ''),
    },
  };
}
