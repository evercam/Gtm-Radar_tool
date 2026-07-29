import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/jwt';

export const dynamic = 'force-dynamic';

/**
 * POST /auth/signout — clears the session and returns to the sign-in page.
 * POST rather than GET so a prefetch or an image tag can't sign a user out.
 *
 * The session is a self-contained token, so signing out is deleting the
 * cookie. Nothing is revoked server-side and nothing needs to be: the token
 * carries its own eight-hour expiry, and there is no session table to fall out
 * of step with it.
 */
export async function POST(request: NextRequest) {
  const { origin } = request.nextUrl;
  const response = NextResponse.redirect(`${origin}/signin`, { status: 303 });

  // Set-then-delete: a bare delete omits the attributes, and a cookie written
  // with a path or Secure flag that does not match is not the one removed.
  response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0));
  response.cookies.delete(SESSION_COOKIE);
  for (const name of ['ldr_oauth_state', 'ldr_oauth_nonce', 'ldr_oauth_next']) response.cookies.delete(name);

  return response;
}
