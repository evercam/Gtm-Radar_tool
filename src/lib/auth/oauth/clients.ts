import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { mintSecret, sha256, sameSecret } from './hash';
import { MCP_SCOPE } from './metadata';

/**
 * Registered client applications, and RFC 7591 dynamic registration.
 *
 * Registration is OPEN — no credential, no admin approval. That is not an
 * oversight and it is worth being explicit about, because it is the first thing
 * anyone reviewing this will stop on.
 *
 * A hosted client such as claude.ai has never heard of this deployment and has
 * no way to be told about it in advance, so the only way it can present itself
 * is to register on the spot. What registration yields is a client_id, which is
 * a public identifier and nothing more. It authorizes NOTHING. To read a single
 * row, a client must additionally:
 *
 *   1. send a person to the consent screen, who
 *   2. must already hold an active Evercam Radar account, and
 *   3. must approve that named client explicitly, after which
 *   4. the code is returned only to a URI fixed at registration time, and
 *   5. redeemed only by whoever holds the matching PKCE verifier.
 *
 * So an unapproved registration is an inert row. The rate limit below is there
 * to stop those rows accumulating — a disk-space concern, not an access one.
 */

/** How many registrations an hour, across everybody. */
const REGISTRATIONS_PER_HOUR = 40;

const missing = (m: string) => /does not exist|schema cache|relation/i.test(m);

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  scope: string;
  isPublic: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  scope: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const toClient = (row: ClientRow): OAuthClient => ({
  clientId: row.client_id,
  clientName: row.client_name,
  redirectUris: row.redirect_uris ?? [],
  grantTypes: row.grant_types ?? [],
  scope: row.scope,
  isPublic: row.client_secret_hash === null,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

/**
 * Is this somewhere an authorization code may be sent?
 *
 * The rules are RFC 8252 §7 and they are stricter than they look necessary,
 * because a redirect URI is the one input that decides where a live credential
 * gets delivered.
 *
 *   - https only, EXCEPT loopback — a desktop MCP client listens on
 *     http://127.0.0.1 on an ephemeral port, and there is no https there to
 *     have. Loopback never leaves the machine, so plaintext costs nothing.
 *   - `localhost` as a NAME is refused where the literal addresses are allowed:
 *     it resolves through whatever the host says, which is not necessarily the
 *     loopback interface. RFC 8252 §8.3 says use the literal.
 *   - No fragment, per RFC 6749 §3.1.2 — the fragment is where the code would
 *     go on an implicit flow, and a client-supplied one collides with it.
 *   - No wildcards and no credentials in the authority.
 */
export function isUsableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.hash) return false;
  if (url.username || url.password) return false;
  if (value.includes('*')) return false;

  if (url.protocol === 'https:') return url.hostname.length > 0;

  if (url.protocol === 'http:') {
    return url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  }

  /*
    A private-use scheme — `com.example.app:/callback` — is how a mobile or
    desktop client claims a callback the OS routes to it. Allowed, but it must
    look like a reversed domain: a bare `myapp:/cb` is claimable by anything.
  */
  if (/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) {
    const scheme = url.protocol.slice(0, -1);
    return scheme.includes('.') && !scheme.startsWith('.');
  }

  return false;
}

export interface RegistrationRequest {
  client_name?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
  token_endpoint_auth_method?: unknown;
  software_id?: unknown;
  software_version?: unknown;
}

export type RegistrationResult =
  | { ok: true; client: OAuthClient; clientSecret: string | null }
  /** `error` is an RFC 7591 §3.2.2 code, returned verbatim to the client. */
  | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata' | 'temporarily_unavailable'; description: string };

/** Registers a client, or explains why not in the words RFC 7591 defines. */
export async function registerClient(body: RegistrationRequest): Promise<RegistrationResult> {
  if (!isSupabaseServiceConfigured()) {
    return { ok: false, error: 'temporarily_unavailable', description: 'This workspace is not connected to its database yet.' };
  }

  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (uris.length === 0) {
    return { ok: false, error: 'invalid_redirect_uri', description: 'At least one redirect_uri is required.' };
  }
  if (uris.length > 10) {
    return { ok: false, error: 'invalid_redirect_uri', description: 'No more than ten redirect_uris.' };
  }
  const bad = uris.find((u) => !isUsableRedirectUri(u));
  if (bad) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: `"${bad}" is not usable: redirect URIs must be https, http on 127.0.0.1, or a reverse-domain private scheme, and must carry no fragment.`,
    };
  }

  /*
    Only the authorization code flow, and only ever with a refresh token
    alongside it. An implicit or password grant request is refused rather than
    quietly downgraded, because a client that asked for implicit and was handed
    something else will fail later in a way that looks like our bug.
  */
  const requested = Array.isArray(body.grant_types)
    ? body.grant_types.filter((g): g is string => typeof g === 'string')
    : ['authorization_code'];
  const unsupported = requested.find((g) => g !== 'authorization_code' && g !== 'refresh_token');
  if (unsupported) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: `grant_type "${unsupported}" is not supported. This server issues authorization_code and refresh_token only.`,
    };
  }

  const responseTypes = Array.isArray(body.response_types)
    ? body.response_types.filter((r): r is string => typeof r === 'string')
    : ['code'];
  const badResponse = responseTypes.find((r) => r !== 'code');
  if (badResponse) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: `response_type "${badResponse}" is not supported. Only "code" is.`,
    };
  }

  const authMethod = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(authMethod)) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: `token_endpoint_auth_method "${authMethod}" is not supported.`,
    };
  }

  const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 120) : 'Unnamed client';

  const supabase = getServiceSupabase();

  // The ceiling on unauthenticated writes. Counted rather than fetched — this
  // runs on every registration and the rows themselves are not wanted.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await supabase
    .from('oauth_clients')
    .select('client_id', { count: 'exact', head: true })
    .gte('created_at', since);

  if (countError && missing(countError.message)) {
    return { ok: false, error: 'temporarily_unavailable', description: 'Run the MCP OAuth migration first.' };
  }
  if ((count ?? 0) >= REGISTRATIONS_PER_HOUR) {
    return {
      ok: false,
      error: 'temporarily_unavailable',
      description: 'Too many client registrations in the last hour. Try again shortly.',
    };
  }

  const clientId = mintSecret('gtmc_');
  // A secret is minted only for a client that said it can keep one. Handing an
  // unwanted secret to a public client would leave it stored somewhere it is not
  // protected, and would tempt a later change into trusting it.
  const clientSecret = authMethod === 'none' ? null : mintSecret('gtms_');

  const { data, error } = await supabase
    .from('oauth_clients')
    .insert({
      client_id: clientId,
      client_secret_hash: clientSecret ? sha256(clientSecret) : null,
      client_name: name,
      redirect_uris: uris,
      grant_types: requested.includes('refresh_token') ? requested : [...requested, 'refresh_token'],
      scope: typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim() : MCP_SCOPE,
      software_id: typeof body.software_id === 'string' ? body.software_id.slice(0, 120) : null,
      software_version: typeof body.software_version === 'string' ? body.software_version.slice(0, 60) : null,
    })
    .select('client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, created_at, last_used_at, revoked_at')
    .maybeSingle();

  if (error || !data) {
    return {
      ok: false,
      error: missing(error?.message ?? '') ? 'temporarily_unavailable' : 'invalid_client_metadata',
      description: missing(error?.message ?? '') ? 'Run the MCP OAuth migration first.' : (error?.message ?? 'Could not store the registration.'),
    };
  }

  return { ok: true, client: toClient(data as ClientRow), clientSecret };
}

/** A live client by id, or null. Revoked reads as absent. */
export async function getClient(clientId: string | null | undefined): Promise<OAuthClient | null> {
  if (!clientId || !isSupabaseServiceConfigured()) return null;
  try {
    const { data, error } = await getServiceSupabase()
      .from('oauth_clients')
      .select('client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, created_at, last_used_at, revoked_at')
      .eq('client_id', clientId)
      .is('revoked_at', null)
      .maybeSingle();
    if (error || !data) return null;
    return toClient(data as ClientRow);
  } catch {
    return null;
  }
}

/**
 * Authenticates a client at the token endpoint.
 *
 * A public client is authenticated by nothing — that is what public means, and
 * PKCE is what stands in for it. A confidential one must present the secret it
 * was issued. The important negative: a client registered WITH a secret is never
 * allowed to skip it by simply not sending one, or the secret would be
 * decoration.
 */
export async function authenticateClient(
  clientId: string | null | undefined,
  presentedSecret: string | null | undefined
): Promise<{ ok: true; client: OAuthClient } | { ok: false; description: string }> {
  if (!clientId) return { ok: false, description: 'client_id is required.' };
  if (!isSupabaseServiceConfigured()) return { ok: false, description: 'This workspace is not connected to its database.' };

  const { data, error } = await getServiceSupabase()
    .from('oauth_clients')
    .select('client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, created_at, last_used_at, revoked_at')
    .eq('client_id', clientId)
    .is('revoked_at', null)
    .maybeSingle();

  if (error || !data) return { ok: false, description: 'Unknown or revoked client_id.' };
  const row = data as ClientRow;

  if (row.client_secret_hash) {
    if (!presentedSecret) return { ok: false, description: 'This client was registered with a secret and must send it.' };
    if (!sameSecret(sha256(presentedSecret), row.client_secret_hash)) return { ok: false, description: 'client_secret does not match.' };
  }

  return { ok: true, client: toClient(row) };
}

/** Records use. Best effort — a failed touch must not fail the request. */
export function touchClient(clientId: string): void {
  if (!isSupabaseServiceConfigured()) return;
  void getServiceSupabase()
    .from('oauth_clients')
    .update({ last_used_at: new Date().toISOString() })
    .eq('client_id', clientId)
    .then(
      () => undefined,
      () => undefined
    );
}
