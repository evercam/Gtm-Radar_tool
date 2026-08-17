/**
 * The OAuth server's security-critical logic — against the real modules.
 *
 * What is tested here is everything that decides whether a credential is handed
 * to the right caller, and the choice of cases follows from what actually goes
 * wrong in a hand-rolled OAuth server:
 *
 *   - PKCE verification, against the RFC's own test vector. If this is wrong in
 *     the permissive direction, possession of an intercepted authorization code
 *     is sufficient to read the lead book, and nothing else in the flow would
 *     notice.
 *   - Redirect URI validation. This decides where a live credential gets
 *     delivered; a prefix match or a stray scheme here is an exfiltration path.
 *   - The discovery URLs, because a single wrong character makes a connector fail
 *     with no diagnostic — and that failure is what this whole subsystem exists
 *     to fix, so a test that pins the paths is worth more than it looks.
 *   - That an unknown client is refused WITHOUT a redirect, per RFC 6749
 *     §4.1.2.1. Bouncing an error to an unverified URI is how an open redirect
 *     gets built by accident.
 *
 * Hermetic: no database, no network. The connection variables are unset below for
 * the same reason test-jwt.mjs unsets them — a shell that has sourced .env.local
 * would otherwise let these reach the real Supabase and test the operator's
 * environment instead of this code.
 *
 *   node --experimental-transform-types scripts/test-oauth.mjs
 */

import { createHash } from 'node:crypto';

delete process.env.SUPABASE_SECRET_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;

const { verifyPkce, sha256, sameSecret, mintSecret } = await import('../src/lib/auth/oauth/hash.ts');
const { isUsableRedirectUri } = await import('../src/lib/auth/oauth/clients.ts');
const { checkAuthorizeRequest, bounceUrl } = await import('../src/lib/auth/oauth/authorize.ts');
const {
  challenge,
  protectedResourceMetadata,
  authorizationServerMetadata,
  PROTECTED_RESOURCE_METADATA_PATH,
  mcpResource,
  MCP_SCOPE,
} = await import('../src/lib/auth/oauth/metadata.ts');

let passed = 0,
  failed = 0;
const check = (n, c, d) => {
  if (c) {
    passed++;
    console.log(`  PASS ${n}`);
  } else {
    failed++;
    console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`);
  }
};
const group = (n) => console.log(`\n${n}`);

const ORIGIN = 'https://radar.example.com';
const pkce = (verifier) => createHash('sha256').update(verifier, 'ascii').digest('base64url');

group('PKCE — the check that makes an intercepted code useless');
/*
  RFC 7636 Appendix B, verbatim. Using the specification's own vector rather than
  a locally generated pair is the point: a self-consistent implementation of the
  WRONG transform passes a round-trip test and fails against every real client.
*/
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
check('the RFC 7636 test vector verifies', verifyPkce(RFC_VERIFIER, RFC_CHALLENGE));
check('our own digest agrees with the RFC vector', pkce(RFC_VERIFIER) === RFC_CHALLENGE);

const verifier = 'a'.repeat(43);
check('a locally generated pair verifies', verifyPkce(verifier, pkce(verifier)));
check('a wrong verifier is refused', !verifyPkce('b'.repeat(43), pkce(verifier)));
check('an empty verifier is refused', !verifyPkce('', pkce(verifier)));
check('an empty challenge is refused', !verifyPkce(verifier, ''));
// The length floor is the entropy floor. Accepting a two-character verifier means
// accepting one an attacker can enumerate offline from the challenge.
check('a verifier under 43 characters is refused', !verifyPkce('short', pkce('short')));
check('a verifier over 128 characters is refused', !verifyPkce('a'.repeat(129), pkce('a'.repeat(129))));
check(
  'a verifier with characters outside the unreserved set is refused',
  !verifyPkce('a'.repeat(42) + '!', pkce('a'.repeat(42) + '!'))
);
/*
  The one that matters most. `plain` PKCE sends the verifier where the challenge
  went, so it protects against nothing — if the challenge were ever compared to
  the raw verifier, an intercepted redirect would carry everything needed.
*/
check('the challenge is never compared as plaintext', !verifyPkce(RFC_VERIFIER, RFC_VERIFIER));

group('Hashing and comparison');
check('sha256 is hex and stable', sha256('x') === sha256('x') && /^[0-9a-f]{64}$/.test(sha256('x')));
check('different inputs hash differently', sha256('x') !== sha256('y'));
check('sameSecret matches equal strings', sameSecret('abc', 'abc'));
check('sameSecret rejects different strings', !sameSecret('abc', 'abd'));
// timingSafeEqual THROWS on length mismatch, so an unguarded call would turn a
// false into a 500 — and a 500 where a denial belongs is itself an oracle.
check('sameSecret returns false rather than throwing on a length mismatch', sameSecret('a', 'abc') === false);
check('a minted secret carries its prefix and enough entropy', /^gtmo_[A-Za-z0-9_-]{43}$/.test(mintSecret('gtmo_')));
check('two minted secrets differ', mintSecret('gtmo_') !== mintSecret('gtmo_'));

group('Redirect URIs — where a live credential is allowed to be delivered');
check('https is allowed', isUsableRedirectUri('https://claude.ai/api/mcp/auth_callback'));
check('https with a port and query is allowed', isUsableRedirectUri('https://example.com:8443/cb?x=1'));
// A desktop MCP client listens on an ephemeral loopback port and has no https to
// offer. Loopback traffic never leaves the machine, so plaintext costs nothing.
check('http on 127.0.0.1 is allowed, for a local client', isUsableRedirectUri('http://127.0.0.1:53682/callback'));
check('http on [::1] is allowed', isUsableRedirectUri('http://[::1]:53682/callback'));
/*
  `localhost` as a NAME is refused where the literal address is allowed: it
  resolves through whatever the host says, which is not necessarily the loopback
  interface. RFC 8252 §8.3 says use the literal.
*/
check('http on localhost-by-name is refused', !isUsableRedirectUri('http://localhost:3000/callback'));
check('plain http elsewhere is refused', !isUsableRedirectUri('http://example.com/callback'));
check('a fragment is refused', !isUsableRedirectUri('https://example.com/cb#part'));
check('credentials in the authority are refused', !isUsableRedirectUri('https://user:pw@example.com/cb'));
check('a wildcard is refused', !isUsableRedirectUri('https://*.example.com/cb'));
check('a reverse-domain private scheme is allowed', isUsableRedirectUri('com.example.app:/oauth/callback'));
check('a bare private scheme is refused as unclaimable', !isUsableRedirectUri('myapp:/callback'));
check('javascript: is refused', !isUsableRedirectUri('javascript:alert(1)'));
check('data: is refused', !isUsableRedirectUri('data:text/html,x'));
check('nonsense is refused', !isUsableRedirectUri('not a url'));
check('an empty string is refused', !isUsableRedirectUri(''));

group('Discovery URLs — one wrong character is a connector that cannot start');
/*
  RFC 9728 §3.1 inserts the resource path INTO the well-known path. Appending it
  after `.well-known/oauth-protected-resource` in the wrong order produces a 404
  that looks, from the client side, exactly like no OAuth server at all.
*/
check(
  'the protected-resource path follows RFC 9728',
  PROTECTED_RESOURCE_METADATA_PATH === '/.well-known/oauth-protected-resource/api/mcp',
  PROTECTED_RESOURCE_METADATA_PATH
);
const prm = protectedResourceMetadata(ORIGIN);
check('the resource is the MCP endpoint itself', prm.resource === `${ORIGIN}/api/mcp`);
check('it names this origin as its authorization server', prm.authorization_servers[0] === ORIGIN);
check('it advertises the one scope', prm.scopes_supported.join() === MCP_SCOPE);

const asm = authorizationServerMetadata(ORIGIN);
// A client compares the issuer in this document against where it fetched the
// document from. A mismatch of one character is a rejected connection.
check('the issuer is exactly the origin', asm.issuer === ORIGIN);
check('the authorization endpoint is the consent page', asm.authorization_endpoint === `${ORIGIN}/oauth/authorize`);
check('the token endpoint is present', asm.token_endpoint === `${ORIGIN}/api/oauth/token`);
check('the registration endpoint is present — this is the one that was missing', asm.registration_endpoint === `${ORIGIN}/api/oauth/register`);
check('only the code flow is offered', asm.response_types_supported.join() === 'code');
check('S256 only — plain is not advertised', asm.code_challenge_methods_supported.join() === 'S256');
check('public clients are supported, for a hosted connector', asm.token_endpoint_auth_methods_supported.includes('none'));
check('the resource identifier is stable', mcpResource(ORIGIN) === `${ORIGIN}/api/mcp`);

group('The WWW-Authenticate challenge — how a client learns OAuth exists here');
const header = challenge(ORIGIN);
check('it is a Bearer challenge', header.startsWith('Bearer '));
check(
  'it points at the protected-resource document',
  header.includes(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`),
  header
);
/*
  Auth-params are comma-separated (RFC 7235 §4.1). Space-separated, a strict
  parser reads the lot as one malformed parameter and discards it — taking
  resource_metadata with it, which is the only part that matters.
*/
check('parameters are comma-separated', challenge(ORIGIN, 'expired').includes('", error="invalid_token", error_description='), challenge(ORIGIN, 'expired'));
check('there is exactly one space, after the scheme', challenge(ORIGIN).split(' ').length === 2, challenge(ORIGIN));
/*
  RFC 6750 §3.1: a request that carried NO credential must not be told its token
  is invalid. That message sends whoever is debugging it hunting for a token they
  never sent.
*/
check('no error code when nothing was presented', !challenge(ORIGIN).includes('error='), challenge(ORIGIN));
check('an error code when a credential was refused', challenge(ORIGIN, 'expired').includes('error="invalid_token"'));
// A quote inside the description would terminate the parameter early and corrupt
// every parameter after it, which is a header a strict client discards entirely.
check('a description with quotes cannot break the header', !challenge(ORIGIN, 'he said "no"').includes('"no"'));
check('a description is carried as error_description', challenge(ORIGIN, 'token expired').includes('error_description="token expired"'));

group('Authorization requests — refusing without becoming an open redirect');
const base = {
  response_type: 'code',
  client_id: 'gtmc_whatever',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_challenge: pkce(verifier),
  code_challenge_method: 'S256',
  state: 'xyz',
};
const ask = (over = {}) => new URLSearchParams({ ...base, ...over });

const noClient = await checkAuthorizeRequest(new URLSearchParams({ redirect_uri: base.redirect_uri }), ORIGIN);
check('a request with no client_id is fatal, not redirected', noClient.kind === 'fatal', noClient.kind);

/*
  With Supabase unconfigured, getClient() returns null — so this exercises the
  unknown-client branch without a database. The assertion that matters is not the
  message but the KIND: an unrecognised client_id must never produce a redirect,
  because the redirect_uri that came with it has not been validated against
  anything and sending an error there would make this endpoint a redirector for
  arbitrary URLs.
*/
const unknown = await checkAuthorizeRequest(ask(), ORIGIN);
check('an unknown client is fatal, not redirected', unknown.kind === 'fatal', unknown.kind);
check('the fatal answer explains itself', unknown.kind === 'fatal' && unknown.detail.length > 40);

const noRedirect = await checkAuthorizeRequest(new URLSearchParams({ client_id: 'gtmc_x', response_type: 'code' }), ORIGIN);
check('a missing redirect_uri is fatal', noRedirect.kind === 'fatal', noRedirect.kind);

group('Error bounces preserve what the client needs');
const bounce = new URL(bounceUrl('https://claude.ai/cb', 'access_denied', 'declined', 'state-123', ORIGIN));
check('the error code is carried', bounce.searchParams.get('error') === 'access_denied');
check('the description is carried', bounce.searchParams.get('error_description') === 'declined');
// state is the CLIENT's CSRF defence. Dropping it makes a conformant client
// refuse the response, which reads as our bug.
check('state is echoed back untouched', bounce.searchParams.get('state') === 'state-123');
check('the issuer is named, per RFC 9207', bounce.searchParams.get('iss') === ORIGIN);
check('the path is left alone', bounce.pathname === '/cb');

const noState = new URL(bounceUrl('https://claude.ai/cb', 'invalid_request', 'x', null, ORIGIN));
check('no state parameter is invented when the client sent none', !noState.searchParams.has('state'));

const withQuery = new URL(bounceUrl('https://claude.ai/cb?keep=1', 'invalid_request', 'x', null, ORIGIN));
check("a redirect_uri's own query survives", withQuery.searchParams.get('keep') === '1');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
