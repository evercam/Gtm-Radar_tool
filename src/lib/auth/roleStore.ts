import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import {
  BUILT_IN_ROLE_PERMISSIONS,
  BUILT_IN_ROLE_LABELS,
  BUILT_IN_ROLE_DESCRIPTIONS,
  KNOWN_PERMISSIONS,
  PERMISSION_LABELS,
  type Permission,
} from './roles';

/**
 * Roles, read from the database instead of from a constant.
 *
 * The permission NAMES stay in code, because each one exists only where
 * something checks it — `can(user, 'routing.edit')` is a real call site. The
 * ROLES, and which permissions each holds, are data an admin can edit.
 *
 * An admin may also invent a permission. It will be stored, offered in the UI
 * and assignable to a role, and it will grant exactly nothing, because nothing
 * reads a name the codebase does not check. That is not a bug to hide — it is
 * reported as `enforced: false` on every path that surfaces one, so a role that
 * looks powerful and is not can be seen for what it is.
 *
 * Every read falls back to the built-in matrix when the table is missing. A
 * workspace that has not run the migration keeps working exactly as before
 * rather than losing every permission at once, which is what an empty result
 * would otherwise mean.
 */

export interface RoleRecord {
  name: string;
  label: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
  /** How many users currently hold it. Only populated by listRoles(). */
  userCount?: number;
}

export interface PermissionRecord {
  name: string;
  label: string;
  description: string;
  /** False means no code reads this name, so holding it changes nothing. */
  isEnforced: boolean;
}

const missing = (message: string) => /does not exist|schema cache|relation|column/i.test(message);

/** The built-in matrix, shaped like the table. Used whenever the table is absent. */
function builtInRoles(): RoleRecord[] {
  return Object.entries(BUILT_IN_ROLE_PERMISSIONS).map(([name, permissions]) => ({
    name,
    label: BUILT_IN_ROLE_LABELS[name] ?? name,
    description: BUILT_IN_ROLE_DESCRIPTIONS[name] ?? '',
    permissions: [...permissions],
    isSystem: true,
  }));
}

export interface RoleSet {
  roles: RoleRecord[];
  /** True when the migration has not been applied and the built-ins are in use. */
  tableMissing: boolean;
}

export async function getRoles(): Promise<RoleSet> {
  if (!isSupabaseServiceConfigured()) return { roles: builtInRoles(), tableMissing: true };
  try {
    const { data, error } = await getServiceSupabase()
      .from('app_roles')
      .select('name, label, description, permissions, is_system')
      .order('name', { ascending: true });
    if (error) {
      if (missing(error.message)) return { roles: builtInRoles(), tableMissing: true };
      throw new Error(error.message);
    }
    const rows = (data ?? []) as {
      name: string;
      label: string;
      description: string;
      permissions: string[] | null;
      is_system: boolean;
    }[];
    // An empty table is not the same as a missing one, but treating it as "no
    // permissions for anybody" would lock the workspace out on a bad truncate.
    if (rows.length === 0) return { roles: builtInRoles(), tableMissing: true };
    return {
      roles: rows.map((r) => ({
        name: r.name,
        label: r.label,
        description: r.description ?? '',
        permissions: r.permissions ?? [],
        isSystem: r.is_system,
      })),
      tableMissing: false,
    };
  } catch {
    return { roles: builtInRoles(), tableMissing: true };
  }
}

/** The permissions one role holds, or an empty list for an unknown role. */
export async function permissionsForRole(role: string | null | undefined): Promise<string[]> {
  if (!role) return [];
  const { roles } = await getRoles();
  return roles.find((r) => r.name === role)?.permissions ?? [];
}

/** Roles plus how many users hold each — for the admin screen. */
export async function listRoles(): Promise<RoleSet> {
  const set = await getRoles();
  if (set.tableMissing || !isSupabaseServiceConfigured()) return set;
  try {
    const { data } = await getServiceSupabase().from('user_profiles').select('role');
    const counts: Record<string, number> = {};
    for (const r of (data ?? []) as { role: string }[]) counts[r.role] = (counts[r.role] ?? 0) + 1;
    return { ...set, roles: set.roles.map((r) => ({ ...r, userCount: counts[r.name] ?? 0 })) };
  } catch {
    return set;
  }
}

/**
 * Every permission that can be ticked, with whether anything enforces it.
 *
 * The compile-time list is the source of truth for `isEnforced`: a stored row
 * saying otherwise is stale the moment a permission is added to or removed from
 * the code, so the code wins and the stored flag is only a cache.
 */
export async function getPermissionCatalog(): Promise<PermissionRecord[]> {
  const enforced = new Set<string>(KNOWN_PERMISSIONS);
  const fromCode: PermissionRecord[] = KNOWN_PERMISSIONS.map((name) => ({
    name,
    label: PERMISSION_LABELS[name] ?? name,
    description: '',
    isEnforced: true,
  }));

  if (!isSupabaseServiceConfigured()) return fromCode;
  try {
    const { data, error } = await getServiceSupabase()
      .from('app_permissions')
      .select('name, label, description')
      .order('name', { ascending: true });
    if (error) return fromCode;

    const byName = new Map(fromCode.map((p) => [p.name, p]));
    for (const r of (data ?? []) as { name: string; label: string; description: string }[]) {
      byName.set(r.name, {
        name: r.name,
        label: r.label || r.name,
        description: r.description ?? '',
        // Not what the row claims — what the code actually checks.
        isEnforced: enforced.has(r.name),
      });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return fromCode;
  }
}

export interface RoleWriteResult {
  ok: boolean;
  message: string;
}

const SLUG = /^[a-z][a-z0-9_.]{1,38}$/;

/** Shared validation for create and update. */
function validate(name: string, label: string, permissions: string[]): string | null {
  if (!SLUG.test(name)) {
    return 'A role name must be lower-case letters, digits, dots or underscores, 2–39 characters, starting with a letter.';
  }
  if (!label.trim()) return 'A role needs a label.';
  const dupes = permissions.filter((p, i) => permissions.indexOf(p) !== i);
  if (dupes.length) return `Duplicate permission: ${dupes[0]}.`;
  for (const p of permissions) {
    if (!SLUG.test(p.replace(/\./g, '.'))) return `"${p}" is not a valid permission name.`;
  }
  return null;
}

export async function createRole(input: {
  name: string;
  label: string;
  description?: string;
  permissions: string[];
}): Promise<RoleWriteResult> {
  const bad = validate(input.name, input.label, input.permissions);
  if (bad) return { ok: false, message: bad };
  if (!isSupabaseServiceConfigured()) return { ok: false, message: 'Supabase service key not configured.' };

  const s = getServiceSupabase();
  const { error } = await s.from('app_roles').insert({
    name: input.name,
    label: input.label.trim(),
    description: input.description?.trim() ?? '',
    permissions: input.permissions,
    is_system: false,
  });
  if (error) {
    if (missing(error.message)) return { ok: false, message: 'Run the dynamic_roles migration first.' };
    if (/duplicate key/i.test(error.message)) return { ok: false, message: `A role named "${input.name}" already exists.` };
    return { ok: false, message: error.message };
  }
  await rememberPermissions(input.permissions);
  return { ok: true, message: `Role "${input.label}" created.` };
}

export async function updateRole(
  name: string,
  patch: { label?: string; description?: string; permissions?: string[] }
): Promise<RoleWriteResult> {
  if (!isSupabaseServiceConfigured()) return { ok: false, message: 'Supabase service key not configured.' };
  const s = getServiceSupabase();

  const { data: current } = await s.from('app_roles').select('name, label, is_system').eq('name', name).maybeSingle();
  const row = current as { name: string; label: string; is_system: boolean } | null;
  if (!row) return { ok: false, message: `No role named "${name}".` };

  const label = patch.label ?? row.label;
  const permissions = patch.permissions ?? [];
  if (patch.permissions) {
    const bad = validate(name, label, permissions);
    if (bad) return { ok: false, message: bad };
  }

  /*
    The last door out.

    Removing users.manage from the only role that has it — or from admin, which
    every install relies on — leaves nobody able to grant it back, and the fix is
    a SQL console. Refused for the same reason the last active admin cannot be
    demoted.
  */
  if (patch.permissions && !permissions.includes('users.manage')) {
    const { roles } = await getRoles();
    const others = roles.filter((r) => r.name !== name && r.permissions.includes('users.manage'));
    if (others.length === 0) {
      return {
        ok: false,
        message: 'This is the only role that can manage users. Give another role that permission first.',
      };
    }
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.label !== undefined) update.label = patch.label.trim();
  if (patch.description !== undefined) update.description = patch.description.trim();
  if (patch.permissions !== undefined) update.permissions = permissions;

  const { error } = await s.from('app_roles').update(update).eq('name', name);
  if (error) return { ok: false, message: error.message };
  if (patch.permissions) await rememberPermissions(permissions);
  return { ok: true, message: `Role "${label}" updated.` };
}

export async function deleteRole(name: string): Promise<RoleWriteResult> {
  if (!isSupabaseServiceConfigured()) return { ok: false, message: 'Supabase service key not configured.' };
  const s = getServiceSupabase();

  const { data } = await s.from('app_roles').select('is_system, label').eq('name', name).maybeSingle();
  const row = data as { is_system: boolean; label: string } | null;
  if (!row) return { ok: false, message: `No role named "${name}".` };
  if (row.is_system) return { ok: false, message: 'Built-in roles cannot be deleted.' };

  // The FK is ON DELETE RESTRICT, so the database would refuse anyway — but a
  // constraint-violation string is not an explanation.
  const { count } = await s.from('user_profiles').select('id', { count: 'exact', head: true }).eq('role', name);
  if ((count ?? 0) > 0) {
    return { ok: false, message: `${count} user(s) still hold this role. Move them first.` };
  }

  const { error } = await s.from('app_roles').delete().eq('name', name);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: `Role "${row.label}" deleted.` };
}

/**
 * Records any permission name we have not seen, so the UI can offer it again.
 *
 * `is_enforced` is left false: this is a name somebody typed, and nothing reads
 * it. getPermissionCatalog recomputes the flag from the code regardless, so a
 * custom permission becomes enforced the moment a real check ships for it —
 * without anyone having to remember to update a row.
 */
async function rememberPermissions(permissions: string[]): Promise<void> {
  const unknown = permissions.filter((p) => !(KNOWN_PERMISSIONS as readonly string[]).includes(p));
  if (unknown.length === 0 || !isSupabaseServiceConfigured()) return;
  try {
    await getServiceSupabase()
      .from('app_permissions')
      .upsert(
        unknown.map((name) => ({ name, label: name, description: 'Custom — no code enforces this yet.', is_enforced: false })),
        { onConflict: 'name' }
      );
  } catch {
    // Best-effort: the role already holds it, this only affects what the picker offers.
  }
}

/** Type guard used where a Permission is expected but a string is in hand. */
export function asPermission(value: string): Permission {
  return value as Permission;
}
