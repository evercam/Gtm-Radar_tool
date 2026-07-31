'use client';

import Link from 'next/link';
import Logo from './Logo';
import { useState } from 'react';
import { Menu } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import UserMenu from '@/components/UserMenu';
import Sidebar from './Sidebar';
import type { Permission, Role } from '@/lib/auth/roles';

/**
 * Slim fixed topbar: brand, and the account controls that don't belong in the
 * nav tree. Navigation itself lives in the sidebar — nothing is duplicated
 * between the two.
 *
 * It owns the mobile sidebar's open state, which is why the sidebar is
 * rendered here rather than beside it in the layout.
 */
export default function Topbar({
  user,
  allowed,
}: {
  user: { email: string | null; fullName: string | null; role: Role } | null;
  allowed: Permission[];
}) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-50 flex h-14 items-center justify-between border-b border-[#1c1c1c] bg-[#0c0c0c] px-4">
        <div className="flex min-w-0 items-center gap-3">
          {user ? (
            <button
              onClick={() => setNavOpen((v) => !v)}
              className="rounded-lg p-1.5 text-[#8a8a8a] transition-colors hover:bg-white/5 hover:text-white lg:hidden"
              aria-label="Toggle navigation"
              aria-expanded={navOpen}
            >
              <Menu size={18} />
            </button>
          ) : null}

          <Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label="Evercam GTM Radar — home">
            {/* The chrome is dark in both themes, so the variant is stated
                rather than derived. */}
            <Logo on="dark" width={104} priority />
            <span className="hidden h-4 w-px shrink-0 bg-white/15 sm:block" />
            <span className="hidden truncate text-[12px] font-medium tracking-tight text-[#8a8a8a] sm:block">
              GTM Radar
            </span>
          </Link>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <ThemeToggle />
          {user ? <UserMenu email={user.email} fullName={user.fullName} role={user.role} /> : null}
        </div>
      </header>

      {user ? <Sidebar open={navOpen} onClose={() => setNavOpen(false)} allowed={allowed} /> : null}
    </>
  );
}
