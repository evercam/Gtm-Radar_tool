'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_SECTIONS, NAV_FOOTER } from '@/lib/nav';
import Logo from './Logo';
import type { Permission } from '@/lib/auth/roles';

/**
 * Dark left rail — the app's primary navigation.
 *
 * A horizontal bar could not hold three groups of destinations without
 * becoming a scrolling strip of undifferentiated links; a vertical rail gives
 * each group a heading and keeps the whole tree visible at once.
 *
 * Sits below the topbar and is fixed, so long tables scroll under it. On
 * narrow screens it slides in over a backdrop instead of occupying a column.
 *
 * `allowed` is resolved server-side and passed down — the sidebar must not
 * decide its own visibility, or it would drift from what the pages enforce.
 */
export default function Sidebar({
  open,
  onClose,
  allowed,
}: {
  open: boolean;
  onClose: () => void;
  allowed: Permission[];
}) {
  const pathname = usePathname();
  const granted = new Set(allowed);

  // `/` would otherwise match every route, so the root is exact; everything else
  // is a prefix match that stops at a path boundary.
  //
  // `/control` used to be exact too, back when its children each had their own
  // rail entry to light up. Now the section is one entry, so it has to stay lit
  // while you are anywhere inside it — otherwise opening Source Hub leaves the
  // rail with nothing highlighted and no sense of where you are.
  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.permission || granted.has(item.permission)),
  })).filter((section) => section.items.length > 0);

  return (
    <>
      {open ? (
        <button
          className="animate-fade-in fixed inset-0 top-14 z-40 bg-black/60 lg:hidden"
          onClick={onClose}
          aria-label="Close navigation"
          tabIndex={-1}
        />
      ) : null}

      <aside
        className={`fixed left-0 top-14 z-50 flex h-[calc(100vh-3.5rem)] w-56 flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-300 ease-in-out ${
          open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
        aria-label="Main navigation"
      >
        <nav className="flex-1 space-y-5 overflow-y-auto px-2.5 py-4">
          {sections.map((section) => (
            <div key={section.title}>
              {/*
                A heading over a single identically-named item reads as a stutter —
                "Operations / Operations" — so the group label is dropped when it
                would only repeat the one link beneath it. Groups that genuinely
                name a set ("Administration" over "Settings") keep theirs.
              */}
              {section.items.length === 1 && section.items[0].label === section.title ? null : (
                <p className="mb-1.5 px-2.5 text-[8px] font-bold uppercase tracking-[0.2em] text-sidebar-heading">
                  {section.title}
                </p>
              )}
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onClose}
                      aria-current={active ? 'page' : undefined}
                      className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors duration-150 ${
                        active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground hover:bg-sidebar-accent-hover hover:text-sidebar-accent-foreground'
                      }`}
                    >
                      {active ? (
                        <span className="bg-brand absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full" />
                      ) : null}
                      <span className="flex w-5 shrink-0 items-center justify-center">
                        <item.icon size={15} strokeWidth={2} />
                      </span>
                      <span className="text-[12px] font-medium leading-none">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/*
          Outside the scrolling nav so it stays put — a link you reach for when
          lost is no use if you have to scroll to find it. Green because it is the
          only entry that explains rather than operates.
        */}
        <div className="border-t border-sidebar-border px-2.5 py-2">
          {NAV_FOOTER.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                aria-current={active ? 'page' : undefined}
                className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors duration-150 ${
                  active
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'text-emerald-400/80 hover:bg-emerald-500/10 hover:text-emerald-300'
                }`}
              >
                {active ? (
                  <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-emerald-400" />
                ) : null}
                <span className="flex w-5 shrink-0 items-center justify-center">
                  <item.icon size={15} strokeWidth={2} />
                </span>
                <span className="text-[12px] font-medium leading-none">{item.label}</span>
              </Link>
            );
          })}
        </div>

        <div className="flex items-center gap-2 border-t border-sidebar-border px-4 py-3">
          <Logo variant="mark" width={16} className="shrink-0 opacity-60" />
          <p className="text-[10px] text-sidebar-subtle">GTM Radar</p>
        </div>
      </aside>
    </>
  );
}
