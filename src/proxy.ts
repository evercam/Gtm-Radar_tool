import { NextResponse, type NextRequest } from 'next/server';
import { permissionForPath, can, isRole, type Role } from '@/lib/auth/roles';
import {
  SESSION_COOKIE,
  verifySession,
  issueSession,
  shouldRefresh,
  sessionCookieOptions,
  SESSION_TTL_SECONDS,
} from '@/lib/auth/jwt';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';

/**
 * Proxy — what earlier Next.js versions called Middleware (renamed in 16).
 *
 * Two jobs:
 *   1. Keep an active session from expiring mid-task, by re-issuing the token
 *      once it is inside its last hour.
 *   2. An *optimistic* access check: bounce obviously-unauthorized requests
 *      before they render.
 *
 * Per the Next.js docs, this is deliberately not the security boundary — it
 * runs before the app and can be bypassed. Every privileged page calls
 * `requirePermission` and every table is protected by RLS. Treat a change here
 * as a UX improvement, never as the thing that keeps data safe.
 *
 * Since sign-in stopped going through Supabase Auth this makes no network call
 * for an ordinary page — verifying the cookie is an HMAC. Only /control/*
 * costs a query.
 */

const PUBLIC_PATHS = [
  '/signin',
  '/api/auth/google',
  '/auth/signout',
  // The scheduler authenticates with a shared secret, not a cookie — the route
  // itself verifies it. Redirecting it to /signin would break every cron run.
  '/api/cron',
  // The questionnaire is a static form an SDR fills before anyone has given
  // them an account. It reads nothing and writes nothing — the file it
  // produces is uploaded by an admin, who is authenticated.
  '/config-questionnaire.html',
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  // With Supabase unconfigured the app runs in its "not connected" state and
  // every page already renders a setup notice — don't redirect into a sign-in
  // page that cannot possibly work.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !isSupabaseServiceConfigured()) {
    return NextResponse.next();
  }

  const claims = await verifySession(request.cookies.get(SESSION_COOKIE)?.value);

  // API routes decide their own outcome. Redirecting a fetch() to an HTML
  // sign-in page would surface as a confusing parse error at the call site;
  // each handler's checkPermission returns a proper 401/403 JSON instead.
  const isApi = pathname.startsWith('/api/');

  if (!claims) {
    if (isApi) return NextResponse.next();
    const signin = request.nextUrl.clone();
    signin.pathname = '/signin';
    signin.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(signin);
  }

  const response = NextResponse.next({ request });

  // Slide the expiry forward for someone who is still working. Only inside the
  // last hour, so this is not a token mint on every request.
  if (shouldRefresh(claims)) {
    const refreshed = await issueSession({ id: claims.sub, email: claims.email ?? null });
    if (refreshed) response.cookies.set(SESSION_COOKIE, refreshed, sessionCookieOptions(SESSION_TTL_SECONDS));
  }

  // Role gate for the Control Center. One query, only on /control/*.
  const required = isApi ? null : permissionForPath(pathname);
  if (required) {
    const { data: profile, error } = await getServiceSupabase()
      .from('user_profiles')
      .select('role, is_active')
      .eq('id', claims.sub)
      .maybeSingle();

    // Before the auth migration runs there is no user_profiles table and no
    // RLS, so nobody can sign in and nothing is protected anyway. Enforcing
    // here would only lock a working install out of itself; every page shows a
    // banner instead, and this flips closed once the table exists.
    if (error && /does not exist|schema cache|relation/i.test(error.message)) return response;

    const row = profile as { role: string; is_active: boolean } | null;
    const role: Role | null = row && isRole(row.role) ? row.role : null;

    if (!row?.is_active || !can(role, required)) {
      const home = request.nextUrl.clone();
      home.pathname = '/';
      home.search = '?denied=1';
      return NextResponse.redirect(home);
    }
  }

  return response;
}

export const config = {
  /**
   * Everything except Next's own assets, the favicon and image files — those
   * would otherwise pay for a session lookup on every request.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
