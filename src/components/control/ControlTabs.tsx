'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CONTROL_TABS, ADMIN_TABS } from '@/lib/nav';
import type { Permission } from '@/lib/auth/roles';

/**
 * The Control Center's tab strip.
 *
 * These are real routes rather than local state, so every tab is
 * deep-linkable, bookmarkable and server-rendered with only its own data —
 * and no single file has to hold every panel. The tab strip is what makes
 * them read as one console instead of nine unrelated pages.
 */
const SETS = { operations: CONTROL_TABS, administration: ADMIN_TABS };

/**
 * `set` is a plain string rather than the tab array itself: each item carries a
 * Lucide `icon`, which is a function, and functions cannot cross the
 * server→client boundary. Passing the array from a server layout throws
 * "Functions cannot be passed directly to Client Components" at render time.
 */
export default function ControlTabs({ set, allowed }: { set: keyof typeof SETS; allowed: Permission[] }) {
  const pathname = usePathname();
  const granted = new Set(allowed);
  const tabs = SETS[set].filter((t) => !t.permission || granted.has(t.permission));

  // A section root (/control) must match exactly, or it would stay lit on
  // every child route and two tabs would look active at once.
  const roots = new Set(['/control', '/admin']);
  const isActive = (href: string) =>
    roots.has(href) ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="border-border-base bg-surface-raised -mx-1 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border p-1">
      {tabs.map((t) => {
        const active = isActive(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-medium transition-colors ${
              active
                ? 'border-border-base bg-surface text-foreground border shadow-[var(--shadow-card)]'
                : 'text-muted hover:text-foreground'
            }`}
          >
            <t.icon size={13} strokeWidth={2} />
            <span>{t.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
