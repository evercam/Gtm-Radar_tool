import 'server-only';
import { getClient, type OAuthClient } from './clients';
import { MCP_SCOPE, mcpResource } from './metadata';

/**
 * Validating an authorization request.
 *
 * Shared by the consent PAGE and the consent ACTION, and that sharing is the
 * point. A server action is a public endpoint — anybody who can invoke it can
 * post whatever fields they like — so the action cannot trust the hidden inputs
 * the page rendered. It re-runs this from scratch. One function means the two
 * cannot drift into disagreeing about what a valid request is, which is the bug
 * where an approval is granted for a request the page never actually displayed.
 *
 * The three-way outcome matters and is prescribed by RFC 6749 §4.1.2.1:
 *
 *   fatal    — the client_id or redirect_uri is wrong, so there is nowhere
 *              trustworthy to send the error. It MUST be shown to the person
 *              instead. Redirecting an error to an unverified URI is how an open
 *              redirect gets built by accident.
 *   bounce   — the client and URI check out but something else does not, so the
 *              error goes back to the client in the query string, with `state`.
 *   ok       — render the consent screen.
 */

export interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  resource: string | null;
  /** Every parameter, re-serialised, so the sign-in round trip can return here. */
  returnTo: string;
}

export type AuthorizeCheck =
  | { kind: 'ok'; request: AuthorizeRequest }
  | { kind: 'fatal'; title: string; detail: string }
  | { kind: 'bounce'; url: string };

/** Builds the error redirect RFC 6749 §4.1.2.1 requires, preserving `state`. */
export function bounceUrl(redirectUri: string, error: string, description: string, state: string | null, issuer?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  // RFC 9207: naming the issuer on the response lets a client with several
  // configured servers tell which one answered, and refuse a response mixed in
  // from another. Cheap to send, and we advertise support for it in the metadata.
  if (issuer) url.searchParams.set('iss', issuer);
  return url.toString();
}

/**
 * Checks an authorization request. Purely a function of the parameters and the
 * client record — the person's identity is checked separately, because a request
 * that is malformed should say so whether or not anybody is signed in.
 */
export async function checkAuthorizeRequest(params: URLSearchParams, origin: string): Promise<AuthorizeCheck> {
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const state = params.get('state');

  if (!clientId) {
    return { kind: 'fatal', title: 'Missing client_id', detail: 'This link is incomplete: it names no application, so there is nothing to approve.' };
  }

  const client = await getClient(clientId);
  if (!client) {
    return {
      kind: 'fatal',
      title: 'Unknown application',
      detail: 'That client_id is not registered here, or its registration has been revoked. If a connector sent you, remove it and add it again so it can register afresh.',
    };
  }

  /*
    EXACT match against a registered URI. Not a prefix, not a host comparison.

    This is the single most important line in the file. Prefix matching turns any
    open redirect on an allowed origin into a way to have authorization codes
    delivered elsewhere, and host matching does the same for any page on the host
    that forwards a query string.
  */
  if (!redirectUri) {
    return { kind: 'fatal', title: 'Missing redirect_uri', detail: 'This link does not say where to return to, and this server will not guess.' };
  }
  if (!client.redirectUris.includes(redirectUri)) {
    return {
      kind: 'fatal',
      title: 'Unregistered redirect address',
      detail: `${client.clientName} asked to be returned to an address it did not register. Nothing has been shared. This is what a tampered authorization link looks like, so it is worth telling whoever sent it.`,
    };
  }

  // From here the redirect_uri is trusted, so errors can go back to the client.
  const bounce = (error: string, description: string): AuthorizeCheck => ({
    kind: 'bounce',
    url: bounceUrl(redirectUri, error, description, state, origin),
  });

  const responseType = params.get('response_type');
  if (responseType !== 'code') {
    return bounce('unsupported_response_type', `response_type must be "code"; got "${responseType ?? 'nothing'}".`);
  }

  const codeChallenge = params.get('code_challenge');
  const method = params.get('code_challenge_method');
  if (!codeChallenge) {
    return bounce('invalid_request', 'code_challenge is required. This server requires PKCE (RFC 7636).');
  }
  if (method !== 'S256') {
    return bounce('invalid_request', `code_challenge_method must be "S256"; got "${method ?? 'nothing'}". The plain method is not accepted.`);
  }
  /*
    A base64url SHA-256 digest is always 43 characters. Checking the shape here
    means a client that sent a raw verifier by mistake — or a `plain` challenge
    while claiming S256 — is told so now, rather than at redemption time where the
    only honest answer is the unhelpful "code_verifier does not match".
  */
  if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) {
    return bounce('invalid_request', 'code_challenge must be the base64url-encoded SHA-256 of the verifier — 43 characters, no padding.');
  }

  /*
    Scope. A client asking for exactly what we offer, or for nothing, gets
    `mcp:read`. A client asking for something else is refused rather than quietly
    downgraded: silently narrowing a scope produces a token that does less than
    the client believes, and the resulting failure surfaces somewhere unrelated.
  */
  const requested = params.get('scope');
  if (requested && requested.trim() && requested.trim() !== MCP_SCOPE) {
    const asked = requested.trim().split(/\s+/);
    const unknown = asked.filter((s) => s !== MCP_SCOPE);
    if (unknown.length > 0) {
      return bounce('invalid_scope', `This server issues only "${MCP_SCOPE}". Not recognised: ${unknown.join(', ')}.`);
    }
  }

  /*
    RFC 8707 resource indicator. The MCP specification requires clients to send
    it; this server does not, because refusing an older client that omits it buys
    nothing while there is exactly one protected resource to be confused about.
    When it IS sent it must name our MCP endpoint — a token minted here should
    never be usable as though it were meant for somewhere else.
  */
  const resource = params.get('resource');
  if (resource) {
    const expected = mcpResource(origin);
    // Compared with the trailing slash normalised away, since a client that
    // stores the URL through a URL object may hand back an equivalent spelling.
    if (resource.replace(/\/+$/, '') !== expected.replace(/\/+$/, '')) {
      return bounce('invalid_target', `This server can only issue tokens for ${expected}.`);
    }
  }

  return {
    kind: 'ok',
    request: {
      client,
      redirectUri,
      state,
      codeChallenge,
      scope: MCP_SCOPE,
      resource: resource ?? null,
      returnTo: `/oauth/authorize?${params.toString()}`,
    },
  };
}

/** The parameters the consent form carries forward, and the action re-validates. */
export const CARRIED_PARAMS = [
  'client_id',
  'redirect_uri',
  'state',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'resource',
] as const;
