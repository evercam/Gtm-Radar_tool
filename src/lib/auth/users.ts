import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { isRole, type Role } from './roles';

export interface UserProfile {
  id: string;
  email: string | null;
  fullName: string | null;
  role: Role;
  bu: string[];
  verticals: string[];
  regions: string[];
  isActive: boolean;
  onboardedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

/**
 * Every user, for the admin table. Uses the service role because RLS
 * deliberately hides other users' rows from everyone but managers and admins,
 * and the caller has already been checked for `users.manage`.
 *
 * `tableMissing` distinguishes "no users yet" from "the migration hasn't run",
 * so the page can show the right message instead of a misleading empty state.
 */
export async function getUserProfiles(): Promise<{ users: UserProfile[]; tableMissing: boolean }> {
  if (!isSupabaseServiceConfigured()) return { users: [], tableMissing: false };

  try {
    const { data, error } = await getServiceSupabase()
      .from('user_profiles')
      .select('id, email, full_name, role, bu, verticals, regions, is_active, onboarded_at, last_seen_at, created_at')
      .order('created_at', { ascending: true });

    if (error) {
      const missing = /schema cache|does not exist|relation/i.test(error.message);
      return { users: [], tableMissing: missing };
    }

    const rows = (data ?? []) as Record<string, unknown>[];
    return {
      tableMissing: false,
      users: rows.map((r) => ({
        id: r.id as string,
        email: (r.email as string) ?? null,
        fullName: (r.full_name as string) ?? null,
        role: isRole(r.role) ? r.role : 'bdr',
        bu: (r.bu as string[]) ?? [],
        verticals: (r.verticals as string[]) ?? [],
        regions: (r.regions as string[]) ?? [],
        isActive: Boolean(r.is_active),
        onboardedAt: (r.onboarded_at as string) ?? null,
        lastSeenAt: (r.last_seen_at as string) ?? null,
        createdAt: r.created_at as string,
      })),
    };
  } catch {
    return { users: [], tableMissing: true };
  }
}
