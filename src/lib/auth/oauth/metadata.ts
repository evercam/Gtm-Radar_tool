/**
 * Where this authorization server lives, and what it says about itself.
 *
 * Pure data derived from the request origin — no I/O, no database — so the two
 * discovery documents, the consent screen and the MCP endpoint's challenge
 * header all read one definition. That matters more here than it looks: an
 * issuer that disagrees with itself by one character between the metadata
 * document and the token endpoint is a rejected connection with no useful error,
 * and it is the single most common way a hand-rolled OAuth server fails.
 *
 * The origin comes from the request rather than a configured base URL, matching
 * what the Google sign-in already does for its redirect URI. That is what lets
 * a Vercel preview deployment be connected as its own workspace without a
 * variable to set, and it is safe because nothing here is a secret and every
 * value is echoed back to the caller that supplied the host.
 */

/**
 * The one scope this server issues.
 *
 * Read access to the MCP endpoint, and that is the whole vocabulary. Resisting a
 * scope-per-tool design is deliberate: the permissions that actually decide what
 * a caller may read are the ROLE's, resolved per request from the database, and a
 * parallel scope system would be a second answer to the same question that could
 * disagree with the first. A scope here would be decoration over the real check.
 */
export const MCP_SCOPE = 'mcp:read';

/** The protected resource itself. */
export const MCP_RESOURCE_PATH = '/api/mcp';

/** Where a person approves a connection. A page, not an endpoint — it has UI. */
export const AUTHORIZE_PATH = '/oauth/authorize';

export const TOKEN_PATH = '/api/oauth/token';
export const REGISTER_PATH = '/api/oauth/register';
export const REVOKE_PATH = '/api/oauth/revoke';

/**
 * RFC 9728 §3.1 — the metadata URL for a resource with a path.
 *
 * The path of the resource is INSERTED between `.well-known/...` and nothing,
 * rather than appended after the resource's own path. Getting this wrong is
 * invisible until a client 404s on discovery, so it is derived here once.
 */
export const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;

export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';

/** The canonical resource identifier clients send as `resource`. */
export const mcpResource = (origin: string) => `${origin}${MCP_RESOURCE_PATH}`;

/**
 * The `WWW-Authenticate` value that starts the whole flow.
 *
 * This header is the entire reason a client knows an OAuth server exists here.
 * A bare 401 tells it only that it is unwelcome; a 401 carrying
 * `resource_metadata` tells it exactly which document to fetch next. Without
 * this, a client is left guessing that the MCP origin is also the authorization
 * server and probing `/register` on it — which is precisely the failure this
 * whole subsystem was built to fix.
 */
export function challenge(origin: string, invalidTokenReason?: string): string {
  /*
    Auth-params are COMMA-separated (RFC 7235 §4.1) and the scheme is separated
    from the first param by a space. Joining the lot with spaces produces a header
    a strict parser reads as one malformed parameter, and then discards — taking
    `resource_metadata` with it and leaving the client back to guessing.
  */
  const params = [`resource_metadata="${origin}${PROTECTED_RESOURCE_METADATA_PATH}"`];

  /*
    `error` is included ONLY when a credential was actually presented and refused.
    RFC 6750 §3.1 is explicit that a request carrying no authentication at all
    should not be answered with an error code — `invalid_token` in that case tells
    the client its token was rejected, which sends anyone debugging it looking for
    a token that was never sent.

    Quotes are stripped from the description because a quoted-string cannot
    contain one unescaped: it would terminate the parameter early and corrupt
    every parameter after it.
  */
  if (invalidTokenReason) {
    params.push('error="invalid_token"');
    params.push(`error_description="${invalidTokenReason.replace(/"/g, '')}"`);
  }

  return `Bearer ${params.join(', ')}`;
}

/** RFC 9728 — what the MCP endpoint publishes about who guards it. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResource(origin),
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Evercam Radar',
    resource_documentation: `${origin}/help`,
  };
}

/** RFC 8414 — what the authorization server publishes about itself. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    registration_endpoint: `${origin}${REGISTER_PATH}`,
    revocation_endpoint: `${origin}${REVOKE_PATH}`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    /*
      S256 only. Advertising `plain` alongside it invites a client to use it, and
      `plain` sends the verifier over the same channel that carried the
      challenge — which is to say it defends against nothing at all.
    */
    code_challenge_methods_supported: ['S256'],
    /*
      `none` first, and it is the expected case: a hosted or desktop client
      cannot keep a secret from the machine it runs on, so PKCE is what binds the
      code to the caller. The secret-based methods are accepted for a client that
      genuinely is confidential — a server-side integration — but nothing here
      relies on the distinction for security.
    */
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    service_documentation: `${origin}/help`,
    /*
      Declared so a strict client does not have to infer it. RFC 8707 resource
      indicators are how a token minted for the MCP endpoint stays useless
      anywhere else, and the MCP specification requires clients to send one.
    */
    authorization_response_iss_parameter_supported: true,
  };
}
