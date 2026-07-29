import {
  Home,
  Inbox,
  Building2,
  BookOpen,
  LayoutGrid,
  Sparkles,
  Wallet,
  Route,
  Users,
  Satellite,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@/lib/auth/roles';

/**
 * The navigation tree.
 *
 * Its own module with no server imports: the sidebar is a client component, so
 * importing this from the shell would pull `next/headers` and the whole
 * session layer into the browser bundle.
 *
 * Each entry carries the permission that reveals it. The sidebar hides what a
 * role cannot open — but hiding is presentation only; the proxy and each page
 * enforce the same permission independently.
 */

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Omitted means every signed-in user sees it. */
  permission?: Permission;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

/**
 * The two operator surfaces are split along the line between running the
 * pipeline and configuring it:
 *
 *   Operations (/control)  the daily loop — find, enrich, route, distribute.
 *                          Changes constantly; a manager lives here.
 *   Administration (/admin) setup that rarely changes — keys, policies, users,
 *                          the source catalog. Admin-only, and dangerous to
 *                          leave sitting next to a button someone clicks daily.
 *
 * KPI is deliberately in neither: performance belongs on the Dashboard, where
 * every seller already starts their day.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Work',
    items: [
      { label: 'Dashboard', href: '/', icon: Home },
      { label: 'My Leads', href: '/records', icon: Inbox },
      { label: 'How it works', href: '/help', icon: BookOpen },
      { label: 'Key Accounts', href: '/accounts', icon: Building2 },
    ],
  },
  {
    title: 'Operations',
    items: [
      { label: 'Overview', href: '/control', icon: LayoutGrid, permission: 'control.access' },
      { label: 'Source Hub', href: '/control/sources', icon: Satellite, permission: 'sources.run' },
      { label: 'Enrichment', href: '/control/enrichment', icon: Sparkles, permission: 'enrichment.run' },
      { label: 'Routing', href: '/control/routing', icon: Route, permission: 'routing.edit' },
      { label: 'Team & Users', href: '/control/team', icon: Users, permission: 'leads.reassign' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { label: 'Settings', href: '/admin/settings', icon: Settings2, permission: 'settings.manage' },
      { label: 'Cost', href: '/admin/costs', icon: Wallet, permission: 'enrichment.run' },
    ],
  },
];

/** Tabs across the top of every Operations page. */
export const CONTROL_TABS: NavItem[] = [
  { label: 'Overview', href: '/control', icon: LayoutGrid, permission: 'control.access' },
  { label: 'Source Hub', href: '/control/sources', icon: Satellite, permission: 'sources.run' },
  { label: 'Enrichment', href: '/control/enrichment', icon: Sparkles, permission: 'enrichment.run' },
  { label: 'Routing', href: '/control/routing', icon: Route, permission: 'routing.edit' },
  { label: 'Team & Users', href: '/control/team', icon: Users, permission: 'leads.reassign' },
];

/** Tabs across the top of every Administration page. */
export const ADMIN_TABS: NavItem[] = [
  { label: 'API Keys & Policies', href: '/admin/settings', icon: Settings2, permission: 'settings.manage' },
  { label: 'Cost', href: '/admin/costs', icon: Wallet, permission: 'enrichment.run' },
];
