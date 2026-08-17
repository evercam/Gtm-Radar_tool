import { NextResponse, type NextRequest } from 'next/server';
import { registerClient, type RegistrationRequest } from '@/lib/auth/oauth/clients';
import { MCP_SCOPE } from '@/lib/auth/oauth/metadata';

export const dynamic = 'force-dynamic';

/**
 * RFC 7591 dynamic client registration.
 *
 * THIS IS THE ENDPOINT WHOSE ABSENCE STARTED ALL OF THIS. A hosted client given
 * only an MCP URL has no client_id and no way to be issued one out of band, so it
 * discovers a registration endpoint and posts its own metadata to it. When there
 * is nothing here, the client falls back to guessing that the MCP origin is also
 * the authorization server, posts to `/register` on it, and receives whatever
 * that path happens to do — in this app's case a redirect to the sign-in page,
 * reported to the user as "couldn't register with the sign-in service".
 *
 * Open and unauthenticated by necessity, which is safe because a registration
 * grants nothing on its own. The reasoning is set out at length in
 * lib/auth/oauth/clients.ts; the short version is that a client_id without a
 * person's approval on the consent screen cannot read a single row.
 *
 * CORS is open because a browser-based client registers itself from its own
 * origin, and a 201 the caller cannot read is a failed registration.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
};

export async function POST(request: NextRequest) {
  let body: RegistrationRequest;
  try {
    body = (await request.json()) as RegistrationRequest;
  } catch {
    return NextResponse.json(
      { error: 'invalid_client_metadata', error_description: 'The body was not JSON.' },
      { status: 400, headers: CORS }
    );
  }

  const result = await registerClient(body);

  if (!result.ok) {
    /*
      RFC 7591 §3.2.2 fixes the status codes: 400 for metadata the server will
      not accept, and it is the client's job to read `error` rather than the
      status. `temporarily_unavailable` gets a 503 instead, because it means come
      back later rather than fix your request — a client that retries a 400
      forever is a client we told the wrong thing.
    */
    const status = result.error === 'temporarily_unavailable' ? 503 : 400;
    return NextResponse.json({ error: result.error, error_description: result.description }, { status, headers: CORS });
  }

  const { client, clientSecret } = result;

  return NextResponse.json(
    {
      client_id: client.clientId,
      // Present only for a client that asked to be confidential, and shown here
      // for the only time it ever will be — the database holds its hash.
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: clientSecret ? 'client_secret_post' : 'none',
      scope: MCP_SCOPE,
      /*
        No expiry on the secret, so this is 0 per the RFC rather than omitted —
        omitting it means "unspecified" and invites a client to guess.
      */
      ...(clientSecret ? { client_secret_expires_at: 0 } : {}),
    },
    { status: 201, headers: CORS }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
}

/**
 * A GET here is somebody in a browser wondering what they have found, or a
 * client probing before it posts. Either way, an explanation beats a 405 with no
 * body — this path existing but appearing broken is exactly the confusion this
 * subsystem was built to end.
 */
export async function GET(request: NextRequest) {
  return NextResponse.json(
    {
      endpoint: 'RFC 7591 dynamic client registration',
      method: 'POST',
      required: { redirect_uris: ['https://example.com/callback'] },
      optional: ['client_name', 'grant_types', 'response_types', 'scope', 'token_endpoint_auth_method', 'software_id', 'software_version'],
      discovery: `${request.nextUrl.origin}/.well-known/oauth-authorization-server`,
      note: 'A client_id grants nothing by itself. Access requires an active Evercam Radar user to approve this client on the consent screen.',
    },
    { headers: CORS }
  );
}
