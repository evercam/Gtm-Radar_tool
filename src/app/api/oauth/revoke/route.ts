import { NextResponse, type NextRequest } from 'next/server';
import { authenticateClient } from '@/lib/auth/oauth/clients';
import { revokeRawToken } from '@/lib/auth/oauth/tokens';

export const dynamic = 'force-dynamic';

/**
 * RFC 7009 token revocation — how a client says "disconnect me".
 *
 * Declared in the discovery document, so it has to exist: a client that reads
 * `revocation_endpoint` and finds a redirect to a sign-in page there will report
 * a failure at exactly the moment somebody is trying to cut off access, which is
 * the worst possible time to be unclear.
 *
 * It answers 200 for a token it has never seen, per §2.2, and that is correct
 * rather than lazy. The caller asked for a token to stop working; a token that
 * does not exist does not work; the request succeeded. Reporting otherwise would
 * also hand anybody a free oracle for testing whether a stolen string is live.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function POST(request: NextRequest) {
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: CORS });
  }

  const token = form.get('token');
  if (!token) return NextResponse.json({ error: 'invalid_request', error_description: 'token is required.' }, { status: 400, headers: CORS });

  /*
    The client is still authenticated first.

    Revocation is unauthenticated-looking but it is not: without this check,
    anybody who learned a token string could disable somebody else's connector,
    which is a denial of service with a very low bar. A confidential client must
    present its secret; a public one is identified by client_id, which is the most
    RFC 7009 §2.1 allows for a client that has no secret to present.
  */
  const auth = await authenticateClient(form.get('client_id'), form.get('client_secret'));
  if (!auth.ok) {
    return NextResponse.json({ error: 'invalid_client', error_description: auth.description }, { status: 401, headers: { ...CORS, 'Cache-Control': 'no-store' } });
  }

  await revokeRawToken(token, auth.client.clientId);

  // 200 with an empty body, per §2.2. Nothing to report either way.
  return new NextResponse(null, { status: 200, headers: { ...CORS, 'Cache-Control': 'no-store' } });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
}
