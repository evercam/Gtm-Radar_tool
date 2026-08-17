import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { permissionsForRole } from '../roleStore';
import { isRole } from '../roles';
import { mintSecret, sha256 } from './hash';

/**
 * Access and refresh tokens.
 *
 * The property that makes this worth building over api_tokens: a token here
 * belongs to a PERSON, and its powers are read from that person's role on every
 * single request. Nothing is baked in at issue time. So deactivating a profile,
 * or narrowing the role it holds, takes effect on the connector's next call
 * without anybody remembering that connectors exist.
 *
 * Opaque and hashed, never a JWT — same reasoning as api_tokens, and it matters
 * more here. A JWT access token would keep answering for its full lifetime after
 * a person left the company, because there would be nothing to look up and
 * therefore nothing to revoke.
 */

/**
 * Eight hours for an access token — deliberately the same as the browser
 * session's TTL. There is no reason for a connector to hold read access longer
 * than the person sitting at a tab, and matching the two means one number to
 * reason about.
 */
const ACCESS_TTL_SECONDS = 8 * 60 * 60;

/**
 * Thirty days for a refresh token, rotated on every use.
 *
 * Long, because the point of a connector is that it keeps working without
 * anybody re-approving it every morning. Safe to be long because it is rotated —
 * a stolen refresh token is usable only until the legitimate client next
 * refreshes, and that event is detected and revokes the whole chain.
 */
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

/** Who an access token turns out to be, in the shape `can()` already takes. */
export interface OAuthIdentity {
  userId: string;
  email: string | null;
  fullName: string | null;
  role: string;
  clientId: string;
  clientName: string;
  scope: string;
  resource: string | null;
  permissions: string[];
}

export interface GrantContext {
  clientId: string;
  userId: string;
  scope: string;
  resource: string | null;
  /** The code this pair descends from, so a replay can revoke exactly this lineage. */
  fromCodeHash?: string | null;
  /** The refresh token being rotated out, for the lineage chain. */
  replacesId?: string | null;
}

/**
 * Issues an access/refresh pair. The plaintexts are returned once and only the
 * hashes are stored, so nothing here can be read back out of the database.
 */
export async function issueTokenPair(grant: GrantContext): Promise<TokenPair | null> {
  if (!isSupabaseServiceConfigured()) return null;

  const accessToken = mintSecret('gtmo_');
  const refreshToken = mintSecret('gtmr_');
  const now = Date.now();

  const shared = {
    client_id: grant.clientId,
    user_id: grant.userId,
    scope: grant.scope,
    resource: grant.resource,
    from_code_hash: grant.fromCodeHash ?? null,
    replaces_id: grant.replacesId ?? null,
  };

  const { error } = await getServiceSupabase()
    .from('oauth_tokens')
    .insert([
      { ...shared, token_hash: sha256(accessToken), kind: 'access', expires_at: new Date(now + ACCESS_TTL_SECONDS * 1000).toISOString() },
      { ...shared, token_hash: sha256(refreshToken), kind: 'refresh', expires_at: new Date(now + REFRESH_TTL_SECONDS * 1000).toISOString() },
    ]);

  if (error) return null;
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS, scope: grant.scope };
}

/**
 * Resolves a bearer token to an identity, or null.
 *
 * Two reads, and both are necessary. The first says the token is live; the
 * second says the person behind it still is. Caching the role onto the token
 * row would save the join and would also mean a deactivated colleague's
 * connector kept reading for another eight hours.
 */
export async function verifyAccessToken(bearer: string | null | undefined): Promise<OAuthIdentity | null> {
  if (!bearer) return null;
  const raw = bearer.replace(/^Bearer\s+/i, '').trim();
  if (!raw.startsWith('gtmo_') || raw.length < 20) return null;
  if (!isSupabaseServiceConfigured()) return null;

  try {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase
      .from('oauth_tokens')
      .select('id, user_id, client_id, scope, resource, expires_at, kind, oauth_clients(client_name)')
      .eq('token_hash', sha256(raw))
      .eq('kind', 'access')
      .is('revoked_at', null)
      .maybeSingle();

    if (error || !data) return null;

    const row = data as {
      id: string;
      user_id: string;
      client_id: string;
      scope: string;
      resource: string | null;
      expires_at: string;
      oauth_clients: { client_name: string } | { client_name: string }[] | null;
    };

    if (new Date(row.expires_at).getTime() <= Date.now()) return null;

    /*
      The role is read live, through the service role.

      Service role because the profile IS the authorization input — reading it
      under a policy that depends on it is circular — and the id being used came
      from a hashed token lookup, not from anything the caller said about itself.
    */
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, email, full_name, role, is_active')
      .eq('id', row.user_id)
      .maybeSingle();

    const person = profile as { id: string; email: string | null; full_name: string | null; role: string; is_active: boolean } | null;
    // An inactive account holds no permissions here. Unlike the browser, there is
    // nothing useful to show a deactivated connector, so it is simply not anybody.
    if (!person || !person.is_active) return null;

    const role = isRole(person.role) ? person.role : 'bdr';

    // Best effort: a failed touch must not fail the request it describes.
    void supabase
      .from('oauth_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', row.id)
      .then(
        () => undefined,
        () => undefined
      );

    const client = Array.isArray(row.oauth_clients) ? row.oauth_clients[0] : row.oauth_clients;

    return {
      userId: person.id,
      email: person.email,
      fullName: person.full_name,
      role,
      clientId: row.client_id,
      clientName: client?.client_name ?? 'Unknown client',
      scope: row.scope,
      resource: row.resource,
      permissions: await permissionsForRole(role),
    };
  } catch {
    return null;
  }
}

export type RefreshResult =
  | { ok: true; pair: TokenPair }
  | { ok: false; description: string };

/**
 * Exchanges a refresh token for a new pair, rotating it.
 *
 * ROTATION IS THE SECURITY MODEL, not a nicety. The old token is marked rotated
 * in the same statement that claims it, so a second use of it cannot succeed —
 * and a second use is not a benign retry, it is somebody else holding a copy.
 * When that happens the entire lineage is revoked, which logs the legitimate
 * client out too. That is the correct trade: being asked to reconnect is a small
 * cost, and it is the only signal the person will ever get that their token was
 * taken.
 */
export async function rotateRefreshToken(input: { refreshToken: string; clientId: string }): Promise<RefreshResult> {
  if (!isSupabaseServiceConfigured()) return { ok: false, description: 'This workspace is not connected to its database.' };

  const raw = input.refreshToken.trim();
  if (!raw.startsWith('gtmr_')) return { ok: false, description: 'That is not a refresh token.' };

  const supabase = getServiceSupabase();
  const hash = sha256(raw);

  const { data, error } = await supabase
    .from('oauth_tokens')
    .select('id, user_id, client_id, scope, resource, expires_at, revoked_at, rotated_at, from_code_hash')
    .eq('token_hash', hash)
    .eq('kind', 'refresh')
    .maybeSingle();

  if (error || !data) return { ok: false, description: 'That refresh token is not valid.' };

  const row = data as {
    id: string;
    user_id: string;
    client_id: string;
    scope: string;
    resource: string | null;
    expires_at: string;
    revoked_at: string | null;
    rotated_at: string | null;
    from_code_hash: string | null;
  };

  if (row.client_id !== input.clientId) return { ok: false, description: 'That refresh token belongs to a different client.' };

  /*
    Already rotated, or already revoked. Either way this is a replay, and the
    live token in this lineage is now suspect — so the lineage goes.
  */
  if (row.rotated_at || row.revoked_at) {
    await revokeLineage(row.from_code_hash, row.client_id, row.user_id);
    return { ok: false, description: 'That refresh token was already used. Every token from this connection has been revoked; reconnect to continue.' };
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, description: 'That refresh token has expired. Reconnect to continue.' };
  }

  // Claim it. `is('rotated_at', null)` is what makes two concurrent refreshes
  // resolve to one winner in the database rather than in JavaScript.
  const { data: claimed, error: claimError } = await supabase
    .from('oauth_tokens')
    .update({ rotated_at: new Date().toISOString(), revoked_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('rotated_at', null)
    .select('id')
    .maybeSingle();

  if (claimError || !claimed) {
    await revokeLineage(row.from_code_hash, row.client_id, row.user_id);
    return { ok: false, description: 'That refresh token was already used. Every token from this connection has been revoked; reconnect to continue.' };
  }

  /*
    The access token issued alongside the old refresh token is retired too.

    Leaving it live would mean a rotation that "revoked" nothing for up to eight
    hours — the interesting credential is the access token, and an attacker who
    replayed the refresh already has one.

    Scoped by originating code where there is one. `.eq(column, null)` matches no
    rows in PostgREST rather than matching NULLs, so the fallback branch is not
    tidiness — without it, a row predating from_code_hash would silently retire
    nothing at all.
  */
  const retire = supabase
    .from('oauth_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('kind', 'access')
    .is('revoked_at', null);

  await (row.from_code_hash
    ? retire.eq('from_code_hash', row.from_code_hash)
    : retire.eq('client_id', row.client_id).eq('user_id', row.user_id));

  const pair = await issueTokenPair({
    clientId: row.client_id,
    userId: row.user_id,
    scope: row.scope,
    resource: row.resource,
    fromCodeHash: row.from_code_hash,
    replacesId: row.id,
  });

  if (!pair) return { ok: false, description: 'Could not issue a new token.' };
  return { ok: true, pair };
}

/**
 * Revokes everything descended from one authorization — the response to a
 * detected replay.
 *
 * Scoped by the originating code where there is one, so one compromised
 * connection does not sign the same person out of their other clients. Falls
 * back to client-and-user when the code is unknown, which only happens for rows
 * predating this column.
 */
export async function revokeLineage(fromCodeHash: string | null, clientId: string, userId: string): Promise<void> {
  if (!isSupabaseServiceConfigured()) return;
  const now = new Date().toISOString();
  const query = getServiceSupabase().from('oauth_tokens').update({ revoked_at: now }).is('revoked_at', null);

  if (fromCodeHash) {
    await query.eq('from_code_hash', fromCodeHash);
    return;
  }
  await query.eq('client_id', clientId).eq('user_id', userId);
}

/** Revokes everything a code produced. Called when a code is redeemed twice. */
export async function revokeTokensFromCode(codeHash: string): Promise<void> {
  if (!isSupabaseServiceConfigured()) return;
  await getServiceSupabase()
    .from('oauth_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('from_code_hash', codeHash)
    .is('revoked_at', null);
}

/**
 * RFC 7009 revocation. Returns quietly whatever happens.
 *
 * The spec requires 200 for an unrecognised token, and it is right to: the
 * caller asked for the token to stop working, and it does not work, so the
 * request succeeded. Reporting "no such token" would also turn this endpoint
 * into a free oracle for checking whether a stolen string is live.
 */
export async function revokeRawToken(raw: string, clientId: string): Promise<void> {
  if (!isSupabaseServiceConfigured() || !raw) return;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('gtmo_') && !trimmed.startsWith('gtmr_')) return;

  const supabase = getServiceSupabase();
  const { data } = await supabase
    .from('oauth_tokens')
    .select('id, kind, from_code_hash, client_id, user_id')
    .eq('token_hash', sha256(trimmed))
    /*
      Scoped to the calling client, per RFC 7009 §2.1: the server verifies the
      token was issued to the client asking. Without this, any registered client
      that learned a token string could disconnect somebody else's connector, and
      registration is open — so that would be a denial of service anyone could
      mount. A miss here is indistinguishable from an unknown token, which is
      also what the caller should be told.
    */
    .eq('client_id', clientId)
    .is('revoked_at', null)
    .maybeSingle();

  const row = data as { id: string; kind: string; from_code_hash: string | null; client_id: string; user_id: string } | null;
  if (!row) return;

  /*
    Revoking a REFRESH token takes the whole connection with it, per RFC 7009 §2.1
    — the client is saying it is done, and leaving its access token live for
    another eight hours would make "disconnect" mean nothing for most of a working
    day. Revoking an access token alone is treated literally, since a client may
    be discarding one it no longer needs while keeping the connection.
  */
  if (row.kind === 'refresh') {
    await revokeLineage(row.from_code_hash, row.client_id, row.user_id);
    return;
  }

  await supabase.from('oauth_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', row.id);
}

/** Everything this person has connected, for the settings screen. */
export interface ConnectionRecord {
  clientId: string;
  clientName: string;
  userId: string;
  email: string | null;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export async function listConnections(): Promise<{ connections: ConnectionRecord[]; tableMissing: boolean }> {
  if (!isSupabaseServiceConfigured()) return { connections: [], tableMissing: true };
  try {
    const { data, error } = await getServiceSupabase()
      .from('oauth_tokens')
      .select('client_id, user_id, scope, created_at, last_used_at, expires_at, oauth_clients(client_name), user_profiles(email)')
      .eq('kind', 'refresh')
      .is('revoked_at', null)
      .order('created_at', { ascending: false });

    if (error) return { connections: [], tableMissing: /does not exist|schema cache|relation/i.test(error.message) };

    return {
      connections: (data ?? []).map((r: Record<string, unknown>) => {
        const client = r.oauth_clients as { client_name: string } | { client_name: string }[] | null;
        const person = r.user_profiles as { email: string | null } | { email: string | null }[] | null;
        const one = Array.isArray(client) ? client[0] : client;
        const who = Array.isArray(person) ? person[0] : person;
        return {
          clientId: r.client_id as string,
          clientName: one?.client_name ?? 'Unknown client',
          userId: r.user_id as string,
          email: who?.email ?? null,
          scope: r.scope as string,
          createdAt: r.created_at as string,
          lastUsedAt: (r.last_used_at as string) ?? null,
          expiresAt: r.expires_at as string,
        };
      }),
      tableMissing: false,
    };
  } catch {
    return { connections: [], tableMissing: true };
  }
}

/** Cuts one person's connection to one client. Used by the settings screen. */
export async function revokeConnection(clientId: string, userId: string): Promise<{ ok: boolean; message: string }> {
  if (!isSupabaseServiceConfigured()) return { ok: false, message: 'Supabase service key not configured.' };
  const { error } = await getServiceSupabase()
    .from('oauth_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('client_id', clientId)
    .eq('user_id', userId)
    .is('revoked_at', null);

  if (error) return { ok: false, message: error.message };
  return { ok: true, message: 'Connection revoked. The next request from it fails and the client is asked to reconnect.' };
}
