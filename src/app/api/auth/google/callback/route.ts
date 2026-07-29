import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { exchangeCode } from '@/lib/auth/google';
import { issueSession, sessionCookieOptions, SESSION_COOKIE, SESSION_TTL_SECONDS } from '@/lib/auth/jwt';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/google/callback — where Google returns.
 *
 * The order matters and is not negotiable: check that we started this flow,
 * then verify the identity, then decide whether this workspace admits it, and
 * only then issue a session. Every failure ends on the sign-in page with a
 * reason, because a silent bounce back to a sign-in form after a successful
 * Google prompt is indistinguishable from a broken app.
 */
export async function GET(request: NextRequest) {
  const { origin, searchParams } = request.nextUrl;

  const signin = (params: Record<string, string>) => {
    const response = NextResponse.redirect(`${origin}/signin?${new URLSearchParams(params)}`);
    for (const name of ['ldr_oauth_state', 'ldr_oauth_nonce', 'ldr_oauth_next']) response.cookies.delete(name);
    return response;
  };

  // The visitor declined at Google's own screen, or Google refused.
  const providerError = searchParams.get('error');
  if (providerError) {
    return signin({ error: providerError === 'access_denied' ? 'cancelled' : 'provider' });
  }

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const expectedState = request.cookies.get('ldr_oauth_state')?.value;
  const nonce = request.cookies.get('ldr_oauth_nonce')?.value;
  const next = request.cookies.get('ldr_oauth_next')?.value || '/';

  if (!code) return signin({ error: 'missing_code' });

  // Constant-time, and only after a length check — timingSafeEqual throws on
  // mismatched lengths, and that throw would itself be a signal.
  const a = Buffer.from(state ?? '');
  const b = Buffer.from(expectedState ?? '');
  if (!state || !expectedState || a.length !== b.length || !timingSafeEqual(a, b)) {
    return signin({ error: 'bad_state' });
  }
  if (!nonce) return signin({ error: 'bad_state' });

  const result = await exchangeCode({ code, origin, nonce });
  if (!result.ok) return signin({ error: result.reason });

  if (!isSupabaseServiceConfigured()) return signin({ error: 'not_configured' });

  // Admission lives in SQL — same allow-list, same one-shot first-admin rule.
  // Called through the service role because it is the only path that may
  // create a profile, and the caller is not yet anybody.
  const { data: userId, error } = await getServiceSupabase().rpc('admit_google_user', {
    p_email: result.identity.email,
    p_full_name: result.identity.name,
    p_google_sub: result.identity.sub,
    p_avatar_url: result.identity.picture,
  });

  if (error || typeof userId !== 'string') {
    return signin({ error: /does not exist|schema cache/i.test(error?.message ?? '') ? 'migration' : 'profile' });
  }

  const { data: profile } = await getServiceSupabase()
    .from('user_profiles')
    .select('id, email, is_active')
    .eq('id', userId)
    .maybeSingle();

  const row = profile as { id: string; email: string | null; is_active: boolean } | null;
  if (!row) return signin({ error: 'profile' });

  // A session is issued either way. An inactive account is refused by every
  // layer above, and holding one is what lets the pending screen name the
  // address instead of asking them to sign in again to be told no.
  const token = await issueSession({ id: row.id, email: row.email });
  if (!token) return signin({ error: 'no_jwt_secret' });

  const destination = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const response = NextResponse.redirect(`${origin}${row.is_active ? destination : '/signin?state=pending'}`);

  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL_SECONDS));
  for (const name of ['ldr_oauth_state', 'ldr_oauth_nonce', 'ldr_oauth_next']) response.cookies.delete(name);

  return response;
}
