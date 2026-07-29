import { getSessionUser } from '@/lib/auth/session';
import { ROLE_PERMISSIONS } from '@/lib/auth/roles';
import Topbar from './Topbar';

/**
 * The app frame: fixed topbar, fixed sidebar, and a content column offset to
 * clear both.
 *
 * A server component so the signed-in user and their permissions are resolved
 * once per request. The permission list is computed here and handed down —
 * the sidebar must never work out its own visibility, or it would drift from
 * what the pages actually enforce.
 *
 * Signed out, the sidebar is absent and the content runs full width, so the
 * sign-in page isn't framed by navigation nobody can use.
 */
export default async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  const allowed = user ? ROLE_PERMISSIONS[user.role] : [];

  return (
    <>
      <Topbar user={user ? { email: user.email, fullName: user.fullName, role: user.role } : null} allowed={allowed} />
      <div className={`min-h-screen pt-14 ${user ? 'lg:pl-56' : ''}`}>
        <main className="mx-auto w-full max-w-screen-2xl px-4 py-8 sm:px-6">{children}</main>
      </div>
    </>
  );
}
