import 'server-only';
import { isCronRequest } from '@/lib/auth/cronSecret';
import { redirect } from 'next/navigation';
import { getRequestSupabase, getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { sessionClaims } from './cookie';
import { can, isRole, BUILT_IN_ROLE_PERMISSIONS, KNOWN_PERMISSIONS, type Permission, type Role } from './roles';
import { permissionsForRole } from './roleStore';
import { isAuthInstalled } from './installed';

/**
 * Server-side session and authorization.
 *
 * The proxy performs an optimistic redirect, but authorization is decided
 * here: every page and route handler that touches privileged data calls
 * `requirePermission` (or at least `getSessionUser`) so a request that slips
 * past the proxy still cannot read anything it shouldn't. Postgres RLS is the
 * third layer beneath both.
 *
 * The identity comes from this app's own session cookie (see lib/auth/jwt.ts),
 * not from Supabase Auth. The token is verified before anything is read from
 * it, and the same token is what the database sees, so the row a page renders
 * and the row RLS permits are decided by one value.
 */

export interface SessionUser {
  id: string;
  email: string | null;
  fullName: string | null;
  role: Role;
  bu: string[];
  verticals: string[];
  regions: string[];
  isActive: boolean;
  onboardedAt: string | null;
  /**
   * The role's permissions, resolved once when the session loads.
   *
   * Roles are database rows now, so `can()` cannot look one up synchronously.
   * Resolving here means every call site downstream stays synchronous — which is
   * what let roles become dynamic without turning twenty checks in pages and
   * route handlers into awaits.
   */
  permissions: string[];
}

/** A request-scoped Supabase client carrying the caller's session JWT. */
export async function getSupabaseSession() {
  return getRequestSupabase();
}

/**
 * The signed-in user with their profile, or null. Never throws — an
 * unconfigured Supabase or a missing profile both read as "not signed in".
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  // Signature and expiry are checked here, before the id is used for
  // anything. An unsigned or expired cookie is simply not a session.
  const claims = await sessionClaims();
  if (!claims) return null;

  // Read through the service role: the profile IS the authorization input, so
  // fetching it under a policy that depends on the profile is circular — and
  // an inactive account must still be able to see that it is inactive. The id
  // comes from a verified signature, not from the request.
  if (!isSupabaseServiceConfigured()) return null;

  const { data: profile } = await getServiceSupabase()
    .from('user_profiles')
    .select('id, email, full_name, role, bu, verticals, regions, is_active, onboarded_at')
    .eq('id', claims.sub)
    .maybeSingle();

  if (!profile) return null;

  const row = profile as {
    id: string;
    email: string | null;
    full_name: string | null;
    role: string;
    bu: string[] | null;
    verticals: string[] | null;
    regions: string[] | null;
    is_active: boolean;
    onboarded_at: string | null;
  };

  const role = isRole(row.role) ? row.role : 'bdr';
  return {
    id: row.id,
    email: row.email ?? claims.email ?? null,
    fullName: row.full_name,
    role,
    bu: row.bu ?? [],
    verticals: row.verticals ?? [],
    regions: row.regions ?? [],
    isActive: row.is_active,
    onboardedAt: row.onboarded_at,
    permissions: await permissionsForRole(role),
  };
}

/**
 * The stand-in identity used only while the auth migration is unapplied, so a
 * pre-auth install keeps working instead of redirecting to a sign-in page that
 * cannot succeed. See lib/auth/installed.ts for why this is safe.
 */
const SETUP_USER: SessionUser = {
  id: '00000000-0000-0000-0000-000000000000',
  email: null,
  fullName: 'Setup mode',
  role: 'admin',
  bu: [],
  verticals: [],
  regions: [],
  isActive: true,
  onboardedAt: null,
  // Pre-migration stand-in: the built-in admin bundle, not a database lookup.
  permissions: [...KNOWN_PERMISSIONS],
};

/** Redirects to sign-in unless somebody is signed in. */
export async function requireUser(returnTo?: string): Promise<SessionUser> {
  if (!(await isAuthInstalled())) return SETUP_USER;

  const user = await getSessionUser();
  if (!user || !user.isActive) {
    redirect(returnTo ? `/signin?next=${encodeURIComponent(returnTo)}` : '/signin');
  }
  return user;
}

/**
 * Redirects unless the signed-in user holds `permission`. Use this at the top
 * of every privileged page — the proxy's check is optimistic and does not
 * substitute for it.
 */
export async function requirePermission(permission: Permission, returnTo?: string): Promise<SessionUser> {
  const user = await requireUser(returnTo);
  if (!can(user, permission)) redirect('/?denied=1');
  return user;
}

/**
 * The identity scheduled jobs run as.
 *
 * A scheduler has no cookies, so it authenticates with the shared CRON_SECRET
 * instead. It is given admin capability because the jobs it triggers —
 * ingestion, prioritisation, export — genuinely need it. The secret is checked
 * on every call and never falls back to "allow" when unset, so an install with
 * no CRON_SECRET simply has no machine caller.
 */
const CRON_USER: SessionUser = {
  id: '00000000-0000-0000-0000-0000000c0f0f',
  email: null,
  fullName: 'Scheduler',
  role: 'admin',
  bu: [],
  verticals: [],
  regions: [],
  isActive: true,
  onboardedAt: null,
  // The scheduler is not a database role; it holds the built-in admin bundle.
  permissions: [...BUILT_IN_ROLE_PERMISSIONS.admin],
};

/** Permission check for route handlers, which return a 403 rather than redirect. */
export async function checkPermission(
  permission: Permission
): Promise<{ ok: true; user: SessionUser } | { ok: false; status: 401 | 403; message: string }> {
  if (!(await isAuthInstalled())) return { ok: true, user: SETUP_USER };
  if (await isCronRequest()) return { ok: true, user: CRON_USER };

  const user = await getSessionUser();
  if (!user || !user.isActive) return { ok: false, status: 401, message: 'Sign in to continue.' };
  if (!can(user, permission)) return { ok: false, status: 403, message: 'Your role does not allow this action.' };
  return { ok: true, user };
}
