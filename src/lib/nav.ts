import {
  Home,
  Inbox,
  Building2,
  BookOpen,
  LayoutGrid,
  Palette,
  Sparkles,
  Wallet,
  Route,
  Users,
  Satellite,
  Settings2,
  History,
  ScrollText,
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
  /**
   * Pages within this one, shown in the rail only while it is the active section.
   *
   * The tab strip that used to carry these is gone. The original objection to
   * listing them here still stands — "a rail that enumerates every page stops
   * being navigation and becomes a table of contents you scroll past" — and it is
   * answered by the "only while active" part rather than ignored: the rail is
   * three entries deep until you are inside Operations, and eight while you are.
   *
   * What has changed since that note is that the links are in ONE place now, not
   * two. The duplication it was written about is what made enumerating them bad.
   */
  children?: NavItem[];
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
/**
 * The rail names a section once; the tabs inside it name the pages.
 *
 * It used to list all five Operations pages and both Administration pages, which
 * put the same seven links in two places — the rail and the tab strip on every
 * one of those pages. A rail that enumerates every page stops being navigation
 * and becomes a table of contents you scroll past.
 *
 * So each operator section is a single destination, and CONTROL_TABS /
 * ADMIN_TABS below carry the pages within it. Nothing became unreachable: the
 * rail lands you on the section's first tab, and the strip is there.
 */
/**
 * The pages inside Operations.
 *
 * Declared before NAV_SECTIONS because the section nests them. Read by the rail
 * and by nothing else — the tab strip that also read this list was removed when
 * the rail took the job, which is exactly why enumerating pages in the rail is
 * acceptable again. The original objection was that the same seven links lived in
 * two places; now there is one.
 *
 * Overview is deliberately absent: it is `/control` itself, which the parent entry
 * already links to, and listing it would put the same href twice in one group.
 */
export const CONTROL_PAGES: NavItem[] = [
  { label: 'Source Hub', href: '/control/sources', icon: Satellite, permission: 'sources.run' },
  { label: 'Enrichment', href: '/control/enrichment', icon: Sparkles, permission: 'enrichment.run' },
  { label: 'Routing', href: '/control/routing', icon: Route, permission: 'routing.edit' },
  // Last, because it is the only one you read rather than operate — and the one
  // you open after a send, not before.
  { label: 'Export History', href: '/control/exports', icon: History, permission: 'leads.export' },
  { label: 'Activity Log', href: '/control/logs', icon: ScrollText, permission: 'logs.view' },
];

/** The pages inside Administration. Settings itself is the parent entry. */
export const ADMIN_PAGES: NavItem[] = [
  /*
    Team & Users lives here, not under Operations.

    It sets quotas, scopes and roles — configuration that rarely changes and is
    dangerous next to a button somebody presses daily, which is the line
    Administration was drawn along in the first place. Operations is the daily
    loop; this is the setup the loop runs on.
  */
  { label: 'Team & Users', href: '/admin/team', icon: Users, permission: 'leads.reassign' },
  { label: 'Cost', href: '/admin/costs', icon: Wallet, permission: 'enrichment.run' },
];

export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Work',
    items: [
      { label: 'Dashboard', href: '/', icon: Home },
      { label: 'My Leads', href: '/records', icon: Inbox },
      { label: 'Key Accounts', href: '/accounts', icon: Building2 },
    ],
  },
  {
    title: 'Operations',
    items: [
      {
        label: 'Operations',
        href: '/control',
        icon: LayoutGrid,
        permission: 'control.access',
        children: CONTROL_PAGES,
      },
    ],
  },
  {
    title: 'Administration',
    // Cost is a child rather than a rail entry of its own. Spend is something you
    // go and look at, not somewhere you navigate to daily.
    items: [
      {
        label: 'Settings',
        href: '/admin/settings',
        icon: Settings2,
        permission: 'settings.manage',
        children: ADMIN_PAGES,
      },
    ],
  },
];

/**
 * Pinned to the bottom of the rail and tinted, because it is the one link that
 * is not a place you work — it explains the pipeline the others operate. Sitting
 * fourth in "Work" it read as another daily destination and was skipped; at the
 * bottom in its own colour it is findable exactly when someone is lost.
 */
export const NAV_FOOTER: NavItem[] = [
  { label: 'How it works', href: '/help', icon: BookOpen },
  /*
    The design guide sits beside it for the same reason: neither is a place you
    work. It is reference, reachable rather than prominent, and it needs no
    permission — it renders no data, so there is nothing to gate.
  */
  { label: 'Design guide', href: '/design-guide', icon: Palette },
];
