import { isAuthInstalled } from '@/lib/auth/installed';

/**
 * Persistent warning while the auth migration is unapplied. Everything is
 * publicly readable in that state, so this says so plainly on every page
 * rather than letting the app look protected when it is not.
 */
export default async function AuthNotInstalled() {
  if (await isAuthInstalled()) return null;

  return (
    <div className="border-danger/40 bg-danger/10 text-danger border-b px-6 py-2 text-center text-xs">
      <strong>No authentication installed.</strong> Every page and record is publicly readable. Apply{' '}
      <code className="font-mono">supabase/migrations/20260726130000_auth_rbac.sql</code> — see{' '}
      <code className="font-mono">supabase/RUN_THESE.md</code>.
    </div>
  );
}
