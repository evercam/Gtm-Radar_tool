/**
 * Roles and the permission matrix.
 *
 * Pure data and pure functions — no I/O — so the same definitions drive the
 * proxy guard, the server-side checks in pages and route handlers, and the
 * navigation. Anything that needs to know "may this user do X" imports `can`
 * from here rather than testing role strings inline.
 */

export const ROLES = ['bdr', 'sdr', 'ae', 'marketing', 'sales_manager', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  bdr: 'BDR',
  sdr: 'SDR',
  ae: 'Account Executive',
  marketing: 'Marketing',
  sales_manager: 'Sales Manager',
  admin: 'Admin',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  bdr: 'Works assigned leads — view, mark handled, transfer',
  sdr: 'Works assigned leads — view, qualify, transfer',
  ae: 'Receives qualified leads — view, export, deal status',
  marketing: 'Works nurture leads — view, nurture, export',
  sales_manager: 'Whole team — reassignment and BU scoring',
  admin: 'Everything, plus users, keys, rules and cron',
};

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
  | 'users.manage';

const BASE_SELLER: Permission[] = ['leads.view.own', 'leads.transfer', 'kpi.view'];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
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
  ],
  admin: [
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
  ],
};

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * The minimum permission each Control Center route requires. The proxy uses
 * this for its optimistic redirect and each page re-checks it server-side —
 * the proxy is a convenience, never the security boundary.
 */
export const ROUTE_PERMISSIONS: { prefix: string; permission: Permission }[] = [
  { prefix: '/admin/settings', permission: 'settings.manage' },
  { prefix: '/admin', permission: 'control.access' },
  { prefix: '/control/enrichment', permission: 'enrichment.run' },
  { prefix: '/admin/costs', permission: 'enrichment.run' },
  { prefix: '/control/team', permission: 'leads.reassign' },
  { prefix: '/control/routing', permission: 'routing.edit' },
  { prefix: '/control/sources', permission: 'sources.run' },
  { prefix: '/control', permission: 'control.access' },
];

/** The permission guarding a path, or null when the path is open to any user. */
export function permissionForPath(pathname: string): Permission | null {
  return (
    ROUTE_PERMISSIONS.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`))?.permission ?? null
  );
}
