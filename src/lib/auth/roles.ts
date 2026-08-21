/**
 * Permissions, and the built-in roles.
 *
 * The split that matters: PERMISSIONS live here because each one exists only
 * where something checks it — `can(user, 'routing.edit')` is a real call site,
 * and a permission with no call site enforces nothing. ROLES live in the
 * database (see roleStore.ts), because a role is just a named bundle of these,
 * and naming a new bundle should not require a deploy.
 *
 * What remains here is the compile-time truth the store needs: which permissions
 * the code actually enforces, and the six built-in roles used as a fallback
 * whenever the roles table is missing — so a workspace that has not run the
 * migration keeps working instead of losing every permission at once.
 *
 * Pure data and pure functions, no I/O, so the same definitions drive the proxy
 * guard, the server-side checks, and the navigation.
 */

/** Every capability the UI or an endpoint can gate on. */
export type Permission =
  | 'leads.view.own'
  | 'leads.view.all'
  | 'leads.qualify'
  | 'leads.transfer'
  | 'leads.reassign'
  | 'leads.export'
  | 'kpi.view'
  | 'kpi.view.team'
  | 'control.access'
  | 'sources.run'
  | 'sources.ingest'
  | 'enrichment.run'
  | 'scoring.edit'
  | 'routing.edit'
  | 'settings.manage'
  | 'credentials.manage'
  | 'users.manage'
  | 'logs.view';

/**
 * The permissions the code enforces, as data.
 *
 * This is what makes "custom permissions" honest: anything an admin invents is
 * absent from this list, and every path that surfaces a permission reports it as
 * unenforced rather than letting it look like it does something.
 */
export const KNOWN_PERMISSIONS: readonly Permission[] = [
  'leads.view.own',
  'leads.view.all',
  'leads.qualify',
  'leads.transfer',
  'leads.reassign',
  'leads.export',
  'kpi.view',
  'kpi.view.team',
  'control.access',
  'sources.run',
  'sources.ingest',
  'enrichment.run',
  'scoring.edit',
  'routing.edit',
  'settings.manage',
  'credentials.manage',
  'users.manage',
  'logs.view',
] as const;

export const PERMISSION_LABELS: Record<string, string> = {
  'leads.view.own': 'View own leads',
  'leads.view.all': 'View all leads',
  'leads.qualify': 'Qualify leads',
  'leads.transfer': 'Transfer leads',
  'leads.reassign': 'Reassign leads',
  'leads.export': 'Export leads',
  'kpi.view': 'View own KPIs',
  'kpi.view.team': 'View team KPIs',
  'control.access': 'Open Control Center',
  'sources.run': 'Run source searches',
  'sources.ingest': 'Ingest from sources',
  'enrichment.run': 'Run enrichment',
  'scoring.edit': 'Edit scoring',
  'routing.edit': 'Edit routing',
  'settings.manage': 'Manage settings',
  'credentials.manage': 'Manage credentials',
  'users.manage': 'Manage users',
  'logs.view': 'Read the activity log',
};

/**
 * A role is now any string the roles table defines.
 *
 * It was a union of six literals, which is exactly what stopped a seventh from
 * existing. Kept as a named type so the intent still reads at call sites.
 */
export type Role = string;

const BASE_SELLER: Permission[] = ['leads.view.own', 'leads.transfer', 'kpi.view'];

/**
 * The six built-ins — the fallback when the roles table is unavailable, and the
 * seed the migration inserts. Editing these no longer changes a running
 * workspace; edit the role in the UI instead.
 */
export const BUILT_IN_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  bdr: [...BASE_SELLER],
  sdr: [...BASE_SELLER, 'leads.qualify'],
  ae: [...BASE_SELLER, 'leads.export'],
  marketing: [...BASE_SELLER, 'leads.export', 'kpi.view.team'],
  sales_manager: [
    'leads.view.own',
    'leads.view.all',
    'leads.qualify',
    'leads.transfer',
    'leads.reassign',
    'leads.export',
    'kpi.view',
    'kpi.view.team',
    'control.access',
    'sources.run',
    'enrichment.run',
    'scoring.edit',
    'routing.edit',
    // The person who notices a job has stopped is the one running the team, so
    // this is not held back for admins.
    'logs.view',
  ],
  admin: [...KNOWN_PERMISSIONS],
};

export const BUILT_IN_ROLE_LABELS: Record<string, string> = {
  bdr: 'BDR',
  sdr: 'SDR',
  ae: 'Account Executive',
  marketing: 'Marketing',
  sales_manager: 'Sales Manager',
  admin: 'Admin',
};

export const BUILT_IN_ROLE_DESCRIPTIONS: Record<string, string> = {
  bdr: 'Works assigned leads — view, mark handled, transfer',
  sdr: 'Works assigned leads — view, qualify, transfer',
  ae: 'Receives qualified leads — view, export, deal status',
  marketing: 'Works nurture leads — view, nurture, export',
  sales_manager: 'Whole team — reassignment and BU scoring',
  admin: 'Everything, plus users, keys, rules and cron',
};

/** Kept for the screens that still render the built-in six by name. */
export const ROLES = Object.keys(BUILT_IN_ROLE_PERMISSIONS);
export const ROLE_LABELS = BUILT_IN_ROLE_LABELS;
export const ROLE_DESCRIPTIONS = BUILT_IN_ROLE_DESCRIPTIONS;
export const ROLE_PERMISSIONS = BUILT_IN_ROLE_PERMISSIONS;

/** Anything carrying a resolved permission list — in practice, a SessionUser. */
export interface PermissionHolder {
  permissions: readonly string[];
}

/**
 * May this caller do this?
 *
 * Takes the RESOLVED permission list rather than a role name, because roles are
 * data now and resolving one means a database read. Doing that read once per
 * request when the session loads keeps every call site synchronous — which is
 * what allowed roles to become dynamic without turning twenty `can(...)` checks
 * in pages and route handlers into awaits.
 */
export function can(holder: PermissionHolder | null | undefined, permission: Permission | string): boolean {
  /*
    Fails closed on a malformed holder rather than throwing.

    An authorization check that throws is worse than one that says no: the throw
    escapes into whatever is rendering the page, and a caller passing the wrong
    shape — a role name, say, which is exactly what this used to take — gets a
    crash instead of a denial. Deny, and let the caller notice they got nothing.
  */
  if (!holder || !Array.isArray(holder.permissions)) return false;
  return holder.permissions.includes(permission);
}

/** Whether a name is one the code actually enforces. */
export function isKnownPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (KNOWN_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Role names are validated against the database now, not against a union, so
 * this only rejects the shapes that could never be a role.
 */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The minimum permission each Control Center route requires. The proxy uses
 * this for its optimistic redirect and each page re-checks it server-side —
 * the proxy is a convenience, never the security boundary.
 */
export const ROUTE_PERMISSIONS: { prefix: string; permission: Permission }[] = [
  { prefix: '/admin/settings', permission: 'settings.manage' },
  { prefix: '/admin/costs', permission: 'enrichment.run' },
  { prefix: '/admin', permission: 'control.access' },
  { prefix: '/control/enrichment', permission: 'enrichment.run' },
  { prefix: '/admin/team', permission: 'leads.reassign' },
  { prefix: '/control/routing', permission: 'routing.edit' },
  { prefix: '/control/sources', permission: 'sources.run' },
  /*
    Read-only, and the one Control Center page an AE or marketer is meant to
    open — so it is guarded by `leads.export` like the page itself, not by
    `control.access` like the rest of /control.

    Without this entry it fell through to the /control catch-all, and the proxy
    turned away exactly the people the page admits: the sidebar offered them
    "Export History" and clicking it redirected to /?denied=1.
  */
  { prefix: '/control/logs', permission: 'logs.view' },
  { prefix: '/control/exports', permission: 'leads.export' },
  { prefix: '/control', permission: 'control.access' },
];

/**
 * The permission guarding a path, or null when the path is open to any user.
 *
 * The MOST SPECIFIC prefix wins, not the first one listed. Order used to decide
 * it, and `/admin/costs` sat below `/admin` in the array — so it matched the
 * broader entry first and its own `enrichment.run` requirement was dead code
 * that no test would ever notice. Nothing was exposed at the time, because every
 * role holding `control.access` also held `enrichment.run`, but that is a
 * coincidence of the built-in matrix rather than a guarantee — and it stops
 * being true the moment an admin defines a role in the database.
 */
export function permissionForPath(pathname: string): Permission | null {
  let best: { prefix: string; permission: Permission } | null = null;
  for (const r of ROUTE_PERMISSIONS) {
    if (pathname !== r.prefix && !pathname.startsWith(`${r.prefix}/`)) continue;
    if (!best || r.prefix.length > best.prefix.length) best = r;
  }
  return best?.permission ?? null;
}
