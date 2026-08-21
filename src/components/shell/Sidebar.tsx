'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
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

  /*
    A group's pages are hidden until asked for.

    They used to appear whenever the section was active, which meant anyone working
    inside Operations carried six extra links they had not asked to see. Now the
    group is a disclosure: hovering opens it, and the chevron toggles it open for
    people who are not hovering anything.

    TWO PIECES OF STATE, NOT ONE.

    `hovered` is transient and `pinned` survives the pointer leaving. One boolean
    cannot do both: with only hover the list vanishes the moment you move toward
    something else in the rail, and with only click it ignores what was asked for.
    Open is either.

    Hover is deliberately NOT the only way in. A pointer is not available to
    keyboard or touch users, so the chevron is a real button with aria-expanded —
    the affordance that makes this navigable without a mouse.
  */
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<Record<string, boolean>>({});
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

  const visible = (item: { permission?: Permission }) => !item.permission || granted.has(item.permission);
  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(visible).map((item) => ({
      ...item,
      // Children are gated individually. Someone with control.access but not
      // logs.view reaches Operations and does not see Activity Log — the same rule
      // the tab strip applied, moved with the links.
      children: item.children?.filter(visible),
    })),
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
                  const link = (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onClose}
                      aria-current={active ? 'page' : undefined}
                      className={`group relative flex items-center gap-3 rounded-xl py-2.5 pl-3 transition-colors duration-150 ${
                        // Room for the chevron, and only on rows that have one.
                        item.children?.length ? 'pr-8' : 'pr-3'
                      } ${
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
                  /*
                    Children only while the section is open, which is what makes
                    putting them here defensible at all.

                    The tab strip that used to carry them is gone, so these links
                    live in one place now rather than two — that was the original
                    objection. The other half of it was length: "a rail that
                    enumerates every page stops being navigation and becomes a table
                    of contents you scroll past." Showing them only inside the
                    active section answers that directly — three entries deep until
                    you are in Operations, nine while you are, and never a list of
                    every page in the app.
                  */
                  if (!item.children?.length) return link;

                  const open = hovered === item.href || pinned[item.href] === true;
                  return (
                    <div
                      key={item.href}
                      /*
                        The wrapper owns the hover, not the link row. The children
                        render inside it, so moving the pointer down onto them never
                        crosses a gap — a flyout anchored to the row alone closes
                        under the cursor on the way to its own contents.
                      */
                      onMouseEnter={() => setHovered(item.href)}
                      onMouseLeave={() => setHovered((h) => (h === item.href ? null : h))}
                    >
                      <div className="relative">
                        {link}
                        {/*
                          The keyboard and touch route in. Sits over the row's right
                          edge rather than inside the Link, because a button nested
                          in an anchor is invalid and swallows the navigation.
                        */}
                        <button
                          type="button"
                          onClick={() => {
                            /*
                              Closing has to beat the hover that is still happening.

                              `open` is hovered OR pinned, so setting pinned=false
                              while the pointer sits on the row leaves it open and
                              the click looks broken. Clearing hover as well makes
                              the click authoritative; moving the pointer out and
                              back re-opens it, which is what hover is for.
                            */
                            if (open) {
                              setPinned((p) => ({ ...p, [item.href]: false }));
                              setHovered((h) => (h === item.href ? null : h));
                            } else {
                              setPinned((p) => ({ ...p, [item.href]: true }));
                            }
                          }}
                          aria-expanded={open}
                          aria-label={`${open ? 'Hide' : 'Show'} ${item.label} pages`}
                          className="text-sidebar-foreground hover:text-sidebar-accent-foreground focus-visible:outline-brand absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 focus-visible:outline-2"
                        >
                          <ChevronRight
                            size={13}
                            strokeWidth={2.5}
                            className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
                          />
                        </button>
                      </div>
                      {!open ? null : (
                      <div className="mt-0.5 space-y-0.5 border-l border-sidebar-border pb-1 pl-3 ml-4">
                        {item.children.map((child) => {
                          const childActive = isActive(child.href);
                          return (
                            <Link
                              key={child.href}
                              href={child.href}
                              onClick={onClose}
                              aria-current={childActive ? 'page' : undefined}
                              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors duration-150 ${
                                childActive
                                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                                  : 'text-sidebar-foreground hover:bg-sidebar-accent-hover hover:text-sidebar-accent-foreground'
                              }`}
                            >
                              <span className="flex w-4 shrink-0 items-center justify-center">
                                <child.icon size={13} strokeWidth={2} />
                              </span>
                              <span className="text-[11px] font-medium leading-none">{child.label}</span>
                            </Link>
                          );
                        })}
                      </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/*
          Outside the scrolling nav so it stays put — a link you reach for when
          lost is no use if you have to scroll to find it. Green because these are
          the entries that explain rather than operate — the tint separates
          reference from the operating rail above, and says nothing about state.
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
                    ? 'bg-sidebar-guide-surface text-sidebar-guide-strong'
                    : 'text-sidebar-guide hover:bg-sidebar-guide-surface-hover hover:text-sidebar-guide-strong'
                }`}
              >
                {active ? (
                  <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-sidebar-guide-mark" />
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
          <p className="text-[10px] text-sidebar-subtle">Radar</p>
        </div>
      </aside>
    </>
  );
}
