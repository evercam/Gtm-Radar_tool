import { requirePermission } from '@/lib/auth/session';

/**
 * Shared frame for Administration.
 *
 * Kept separate from Operations because the two are used on completely
 * different rhythms: a manager runs Operations every day, while these are
 * setup screens touched occasionally — and a destructive action like rotating
 * a key or changing a role should not sit one tab away from a button somebody
 * clicks each morning.
 *
 * `control.access` is the floor here; each page still asserts its own,
 * stricter permission.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // The call is the gate; its return value is no longer needed here now that the
  // tab strip (which filtered itself by role) has moved to the rail.
  await requirePermission('control.access', '/admin');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <span className="border-border-strong bg-surface-raised text-body inline-block rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em]">
        Administration
      </span>

      <div>{children}</div>
    </div>
  );
}
