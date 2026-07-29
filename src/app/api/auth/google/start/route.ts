import { NextResponse, type NextRequest } from 'next/server';
import { googleCredentials, authorizeUrl } from '@/lib/auth/google';
import { randomToken, sessionCookieOptions } from '@/lib/auth/jwt';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/google/start — begins sign-in.
 *
 * `state` and `nonce` are minted here and parked in short-lived httpOnly
 * cookies. State is what makes the callback refuse a request the user did not
 * start; nonce is what ties the identity Google returns to this browser. Both
 * are checked in the callback and cleared there.
 */
export async function GET(request: NextRequest) {
  const { origin, searchParams } = request.nextUrl;
  const next = searchParams.get('next') || '/';
  const destination = next.startsWith('/') && !next.startsWith('//') ? next : '/';

  const creds = await googleCredentials();
  if (!creds) return NextResponse.redirect(`${origin}/signin?error=not_configured`);

  const state = randomToken();
  const nonce = randomToken();

  const response = NextResponse.redirect(
    authorizeUrl({ clientId: creds.clientId, origin, state, nonce })
  );

  // Ten minutes: long enough to pick an account and type a password, short
  // enough that an abandoned attempt cannot be resumed later.
  const options = sessionCookieOptions(600);
  response.cookies.set('ldr_oauth_state', state, options);
  response.cookies.set('ldr_oauth_nonce', nonce, options);
  response.cookies.set('ldr_oauth_next', destination, options);

  return response;
}
