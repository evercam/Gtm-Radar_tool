'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ROLE_LABELS, type Role } from '@/lib/auth/roles';

/** Avatar, identity and sign-out. Closes on outside click and on Escape. */
export default function UserMenu({
  email,
  fullName,
  role,
}: {
  email: string | null;
  fullName: string | null;
  role: Role;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name = fullName || email || 'Account';
  const initials = name.slice(0, 2).toUpperCase();

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-xs font-semibold text-white transition-colors hover:bg-white/30"
        title={name}
      >
        {initials}
      </button>

      {open ? (
        <div
          role="menu"
          className="animate-rise-in border-border-base bg-surface absolute right-0 mt-2 w-56 rounded-[12px] border py-1 shadow-[var(--shadow-overlay)]"
        >
          <div className="border-border-base border-b px-3 py-2">
            <p className="text-foreground truncate text-sm font-medium">{name}</p>
            <p className="text-muted truncate text-xs">{email}</p>
            <p className="text-subtle mt-0.5 text-[11px]">{ROLE_LABELS[role]}</p>
          </div>

          <Link
            href="/profile"
            onClick={() => setOpen(false)}
            className="text-foreground hover:bg-surface-raised block px-3 py-2 text-sm"
            role="menuitem"
          >
            Profile
          </Link>

          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="text-foreground hover:bg-surface-raised block w-full px-3 py-2 text-left text-sm"
              role="menuitem"
            >
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
