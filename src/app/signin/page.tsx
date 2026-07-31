import { redirect } from 'next/navigation';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/auth/session';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import SignInForm from '@/components/auth/SignInForm';
import { Card, CardBody } from '@/components/ui';
import Logo from '@/components/shell/Logo';

export const dynamic = 'force-dynamic';

/**
 * What went wrong, in our words rather than the provider's.
 *
 * Split by who can fix it: a visitor is told what to do, an administrator is
 * told what is misconfigured. Being vague about a setup fault helps nobody —
 * these are all pre-authentication states, so there is no account to protect
 * by staying quiet.
 */
const MESSAGES: Record<string, string> = {
  cancelled: 'Sign-in was cancelled at Google. Nothing happened.',
  provider: 'Google could not complete the sign-in. Try again.',
  missing_code: 'Google did not return a sign-in code. Try again.',
  bad_state: 'That sign-in attempt expired or did not start here. Try again.',
  nonce_mismatch: 'That sign-in attempt did not start in this browser. Try again.',
  unverified_email: 'Google has not verified that address. Verify it with Google first.',
  no_email: 'That Google account has no email address on it.',
  network: 'Could not reach Google. Check the connection and try again.',
  expired: 'That sign-in took too long. Try again.',
  // Setup faults — an admin reading over their shoulder needs the specifics.
  not_configured: 'Google sign-in is not set up yet: add the client ID and secret in Settings.',
  no_jwt_secret: 'Sign-in could not store its signing key. Check the database connection and try again.',
  migration: 'The database is missing the sign-in migration. Apply it and try again.',
  redirect_mismatch:
    'Google rejected this app’s redirect URI. Add /api/auth/google/callback to the OAuth client in Google Cloud.',
  wrong_audience: 'Google returned a token for a different application. Check the client ID in Settings.',
  wrong_issuer: 'That token did not come from Google.',
  bad_signature: 'That token could not be verified against Google’s keys.',
  exchange_failed: 'Google refused the sign-in. Check the client secret in Settings.',
  no_id_token: 'Google returned no identity. Check the OAuth client’s scopes.',
  profile: 'Signed in, but the account record could not be read.',
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; state?: string }>;
}) {
  if (!isSupabaseServerConfigured()) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <SupabaseNotConfigured detail="Authentication needs Supabase. Configure it in .env.local, then reload." />
      </div>
    );
  }

  const user = await getSessionUser();
  const { next, error, state } = await searchParams;

  // Only an ACTIVE account is sent onward. An inactive one still holds a valid
  // session, so redirecting it would bounce between here and requireUser
  // forever; it gets the pending notice below instead.
  if (user?.isActive) redirect(next || '/');

  const pending = state === 'pending' || (user !== null && !user.isActive);

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6 py-16">
      {/* The only surface that follows the theme, so the variant is left to
          CSS here rather than stated. */}
      <Logo width={148} priority />
      <h1 className="text-foreground mt-6 text-2xl font-bold">{pending ? 'Almost there' : 'Sign in'}</h1>
      <p className="text-muted mt-1 text-sm">GTM Radar</p>

      {pending ? (
        <Card className="mt-6">
          <CardBody>
            <p className="text-foreground text-sm font-medium">This account is waiting for approval</p>
            <p className="text-muted mt-2 text-sm">
              {user?.email ? <span className="font-medium">{user.email}</span> : 'That address'} signed in
              successfully, but is not on this workspace&rsquo;s list yet. An admin can activate it under Team &amp;
              Users — you will not need to sign in again once they have.
            </p>
            {/* POST, because /auth/signout refuses GET — a prefetch must not
                be able to sign anyone out. */}
            <form action="/auth/signout" method="post" className="mt-3">
              <button type="submit" className="text-brand text-xs underline">
                Sign out and use a different account
              </button>
            </form>
          </CardBody>
        </Card>
      ) : (
        <>
          {error && MESSAGES[error] ? (
            <p className="border-danger/30 bg-danger/5 text-danger mt-4 rounded-lg border px-3 py-2 text-sm">
              {MESSAGES[error]}
            </p>
          ) : null}
          <div className="mt-6">
            <SignInForm next={next} />
          </div>
        </>
      )}
    </div>
  );
}
