import 'server-only';
import { getReadSupabase } from '@/lib/supabase/server';

/**
 * Whether the auth migration has been applied.
 *
 * The app enforced no authentication at all before this feature landed, so a
 * database that predates the migration has no `user_profiles` table and no
 * RLS. Hard-failing every request in that state would brick a working install
 * behind a sign-in page that cannot possibly succeed — there are no users to
 * sign in as.
 *
 * So the app degrades OPEN while the table is absent, and flips CLOSED the
 * moment it exists. That is not a security decision dressed up as a fallback:
 * pre-migration there is nothing to enforce, because the tables are public
 * either way. A loud banner (see AuthNotInstalled) says so on every page, and
 * the Control Center health panel reports it.
 *
 * Cached for the lifetime of the server process: applying a migration
 * restarts the dev server, and in production this flips once at deploy.
 */
let cached: boolean | null = null;

export async function isAuthInstalled(): Promise<boolean> {
  if (cached !== null) return cached;
  try {
    const { error } = await (await getReadSupabase()).from('user_profiles').select('id').limit(1);
    // A missing table reports as 42P01 / "does not exist" / a schema-cache miss.
    // Any other error (including RLS denying the row) means the table is there.
    cached = !(error && /does not exist|schema cache|relation/i.test(error.message));
  } catch {
    cached = false;
  }
  return cached;
}

/** Test hook — forces the next call to re-check. */
export function resetAuthInstalledCache(): void {
  cached = null;
}
