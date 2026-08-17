import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { mintSecret, sha256, verifyPkce } from './hash';

/**
 * Authorization codes — the thing a person's approval turns into.
 *
 * A code is the shortest-lived and most dangerous credential in the system: it
 * travels through a browser redirect, which means it passes through the URL bar,
 * the history, and any referrer header along the way. Everything here follows
 * from that.
 *
 *   - It lives two minutes.
 *   - It is single use, and a second attempt is treated as evidence rather than
 *     as a mistake (see `consumeCode`).
 *   - It is bound to a PKCE challenge, so possessing the code is not enough.
 *   - It is bound to the redirect_uri it was issued for and the client that
 *     asked, both re-checked at redemption.
 *
 * Only the hash is stored, so a leaked database yields no redeemable codes.
 */

/**
 * Two minutes.
 *
 * RFC 6749 §4.1.2 permits up to ten and recommends short. The redemption is a
 * server-to-server call the client makes immediately on receiving the redirect,
 * so the only thing a longer window buys is a longer replay opportunity.
 */
const CODE_TTL_SECONDS = 120;

export interface CodeGrant {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string | null;
}

/** Mints a code for an approval that has already happened. Returns the plaintext once. */
export async function mintCode(grant: CodeGrant): Promise<string | null> {
  if (!isSupabaseServiceConfigured()) return null;

  const code = mintSecret('gtmac_');
  const { error } = await getServiceSupabase().from('oauth_authorization_codes').insert({
    code_hash: sha256(code),
    client_id: grant.clientId,
    user_id: grant.userId,
    redirect_uri: grant.redirectUri,
    code_challenge: grant.codeChallenge,
    code_challenge_method: 'S256',
    scope: grant.scope,
    resource: grant.resource,
    expires_at: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
  });

  return error ? null : code;
}

export type ConsumeResult =
  | { ok: true; userId: string; scope: string; resource: string | null; codeHash: string }
  | { ok: false; error: 'invalid_grant'; description: string; replayed?: boolean };

/**
 * Redeems a code, exactly once.
 *
 * Every check returns the same `invalid_grant` with a description, and the
 * descriptions distinguish causes only in ways already known to the caller — it
 * supplied the code, the client_id, the redirect_uri and the verifier, so being
 * told which of its own inputs disagreed leaks nothing to it and saves an hour of
 * somebody's debugging. What is never distinguished is "no such code" from
 * "expired": that difference would tell an attacker probing random codes when it
 * had guessed a real one.
 */
export async function consumeCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<ConsumeResult> {
  if (!isSupabaseServiceConfigured()) {
    return { ok: false, error: 'invalid_grant', description: 'This workspace is not connected to its database.' };
  }

  const codeHash = sha256(input.code);
  const supabase = getServiceSupabase();

  const { data, error } = await supabase
    .from('oauth_authorization_codes')
    .select('code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at, consumed_at')
    .eq('code_hash', codeHash)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, error: 'invalid_grant', description: 'That authorization code is not valid or has expired.' };
  }

  const row = data as {
    code_hash: string;
    client_id: string;
    user_id: string;
    redirect_uri: string;
    code_challenge: string;
    scope: string;
    resource: string | null;
    expires_at: string;
    consumed_at: string | null;
  };

  /*
    Replay. Reported distinctly so the caller can revoke what this code already
    produced — a code arriving twice means either a client bug or an interception,
    and in the second case the tokens from the first redemption are in the wrong
    hands right now.
  */
  if (row.consumed_at) {
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'That authorization code has already been used. Everything issued from it has been revoked.',
      replayed: true,
    };
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, error: 'invalid_grant', description: 'That authorization code is not valid or has expired.' };
  }

  // The code was issued to one client. Another client presenting it — even a
  // legitimately registered one — is not the caller it was minted for.
  // A plain comparison: client_id is a public identifier, and a constant-time
  // check on a value the caller already knows would be theatre.
  if (row.client_id !== input.clientId) {
    return { ok: false, error: 'invalid_grant', description: 'That authorization code was issued to a different client.' };
  }

  // RFC 6749 §4.1.3: the redirect_uri must be repeated and must match. This is
  // what stops a code obtained via one registered URI being redeemed as though
  // it came back through another.
  if (row.redirect_uri !== input.redirectUri) {
    return { ok: false, error: 'invalid_grant', description: 'redirect_uri does not match the one this code was issued for.' };
  }

  if (!verifyPkce(input.codeVerifier, row.code_challenge)) {
    return { ok: false, error: 'invalid_grant', description: 'code_verifier does not match the code_challenge.' };
  }

  /*
    Claim it, and let the DATABASE decide who won.

    `is('consumed_at', null)` in the update is the whole concurrency story: two
    simultaneous redemptions of the same code both pass the read above, and
    exactly one of them matches this predicate. Checking `consumed_at` in
    JavaScript and then writing would let both through, which is precisely the
    race an interceptor would try to win.
  */
  const { data: claimed, error: claimError } = await supabase
    .from('oauth_authorization_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('code_hash', codeHash)
    .is('consumed_at', null)
    .select('code_hash')
    .maybeSingle();

  if (claimError || !claimed) {
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'That authorization code has already been used.',
      replayed: true,
    };
  }

  return { ok: true, userId: row.user_id, scope: row.scope, resource: row.resource, codeHash };
}

/** Opportunistic housekeeping — see the migration for why this is not a cron job. */
export function purgeExpired(): void {
  if (!isSupabaseServiceConfigured()) return;
  void getServiceSupabase()
    .rpc('purge_expired_oauth')
    .then(
      () => undefined,
      () => undefined
    );
}
