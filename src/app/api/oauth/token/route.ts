import { NextResponse, type NextRequest } from 'next/server';
import { authenticateClient, touchClient } from '@/lib/auth/oauth/clients';
import { consumeCode, purgeExpired } from '@/lib/auth/oauth/codes';
import { issueTokenPair, rotateRefreshToken, revokeTokensFromCode } from '@/lib/auth/oauth/tokens';
import { sha256 } from '@/lib/auth/oauth/hash';

export const dynamic = 'force-dynamic';

/**
 * The token endpoint — RFC 6749 §3.2, with PKCE and rotation.
 *
 * Two grants, and no others: `authorization_code` to redeem an approval, and
 * `refresh_token` to keep a connection alive. Both paths end in the same place,
 * `issueTokenPair`, so there is one definition of what a token is.
 *
 * Everything that decides whether the request is legitimate lives in the library
 * modules — PKCE in hash.ts, single-use claiming in codes.ts, rotation in
 * tokens.ts — and this handler is deliberately thin. It parses a form body,
 * picks a grant, and translates the result into the error shape RFC 6749 §5.2
 * defines. Authorization logic here rather than there would be logic without a
 * test around it.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
};

/**
 * RFC 6749 §5.2 — `no-store` is required, not advisory.
 *
 * The body contains a bearer token in plaintext. A cache anywhere between here
 * and the client that keeps it is a credential at rest in a place nobody is
 * watching, and on a platform that caches aggressively by default this header is
 * the only thing preventing it.
 */
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

const fail = (error: string, description: string, status = 400) =>
  NextResponse.json({ error, error_description: description }, { status, headers: { ...CORS, ...NO_STORE } });

/**
 * Client credentials, from either place RFC 6749 allows them.
 *
 * `client_secret_basic` (the Authorization header) takes precedence over
 * `client_secret_post` (the body) when both appear, per §2.3.1. A public client
 * sends neither and is authenticated by PKCE instead.
 */
function clientCredentials(request: NextRequest, form: URLSearchParams): { clientId: string | null; clientSecret: string | null } {
  const header = request.headers.get('authorization');
  if (header?.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator > 0) {
        // Both halves are form-urlencoded inside Basic auth, per §2.3.1 — a
        // secret containing a `+` decodes wrong without this.
        return {
          clientId: decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, ' ')),
          clientSecret: decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, ' ')),
        };
      }
    } catch {
      // A malformed header falls through to the body, which is more useful than
      // refusing a client that also sent usable credentials there.
    }
  }

  return {
    clientId: form.get('client_id'),
    clientSecret: form.get('client_secret'),
  };
}

export async function POST(request: NextRequest) {
  let form: URLSearchParams;
  try {
    /*
      `application/x-www-form-urlencoded`, per the spec. Read as text and parsed
      rather than via formData() so that a client sending JSON — which several
      do, wrongly — gets a clear error instead of a framework-level parse failure
      surfacing as a 500.
    */
    form = new URLSearchParams(await request.text());
  } catch {
    return fail('invalid_request', 'The body could not be read.');
  }

  const grantType = form.get('grant_type');
  if (!grantType) return fail('invalid_request', 'grant_type is required.');

  const { clientId, clientSecret } = clientCredentials(request, form);
  const auth = await authenticateClient(clientId, clientSecret);
  // §5.2: a failed client authentication is 401 and `invalid_client`, distinct
  // from a bad grant — the client needs to know its own identity was refused
  // rather than the credential it presented on somebody's behalf.
  if (!auth.ok) return fail('invalid_client', auth.description, 401);

  const client = auth.client;

  if (grantType === 'authorization_code') {
    const code = form.get('code');
    const redirectUri = form.get('redirect_uri');
    const codeVerifier = form.get('code_verifier');

    if (!code) return fail('invalid_request', 'code is required.');
    if (!redirectUri) return fail('invalid_request', 'redirect_uri is required, and must match the one used to obtain the code.');
    if (!codeVerifier) return fail('invalid_request', 'code_verifier is required. This server requires PKCE.');

    const consumed = await consumeCode({ code, clientId: client.clientId, redirectUri, codeVerifier });

    if (!consumed.ok) {
      /*
        A replayed code means whatever it already produced is in somebody's hands.
        Revoking here rather than inside consumeCode keeps that module free of
        token concerns, but it must not be forgotten — hence the explicit flag on
        the result rather than an inference from the message.
      */
      if (consumed.replayed) await revokeTokensFromCode(sha256(code));
      return fail(consumed.error, consumed.description);
    }

    const pair = await issueTokenPair({
      clientId: client.clientId,
      userId: consumed.userId,
      scope: consumed.scope,
      resource: consumed.resource,
      fromCodeHash: consumed.codeHash,
    });

    if (!pair) return fail('server_error', 'Could not issue a token. Check that the MCP OAuth migration has been applied.', 500);

    touchClient(client.clientId);
    // Opportunistic, and after the response is decided so a slow delete cannot
    // delay a token the client is waiting on.
    purgeExpired();

    return NextResponse.json(
      {
        access_token: pair.accessToken,
        token_type: 'Bearer',
        expires_in: pair.expiresIn,
        refresh_token: pair.refreshToken,
        scope: pair.scope,
      },
      { headers: { ...CORS, ...NO_STORE } }
    );
  }

  if (grantType === 'refresh_token') {
    const refreshToken = form.get('refresh_token');
    if (!refreshToken) return fail('invalid_request', 'refresh_token is required.');

    const rotated = await rotateRefreshToken({ refreshToken, clientId: client.clientId });
    if (!rotated.ok) return fail('invalid_grant', rotated.description);

    touchClient(client.clientId);

    return NextResponse.json(
      {
        access_token: rotated.pair.accessToken,
        token_type: 'Bearer',
        expires_in: rotated.pair.expiresIn,
        // Always returned, because it always changed. A client that reuses the
        // one it sent will be treated as a replay on its next refresh.
        refresh_token: rotated.pair.refreshToken,
        scope: rotated.pair.scope,
      },
      { headers: { ...CORS, ...NO_STORE } }
    );
  }

  return fail(
    'unsupported_grant_type',
    `"${grantType}" is not supported. This server issues authorization_code and refresh_token.`
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
}

export async function GET() {
  return fail('invalid_request', 'The token endpoint takes a POST with an application/x-www-form-urlencoded body.', 405);
}
