import { requirePermission } from '@/lib/auth/session';

/**
 * Shared frame for the Control Center.
 *
 * Every operator surface gets the same header, so they read as one console. The
 * tab strip that used to sit here moved into the rail: the pages are listed under
 * Operations while you are inside it, which puts them in one place instead of two. The `control.access` check here is a floor, not the whole
 * gate — each page still asserts its own, more specific permission, because a
 * layout does not re-run on every navigation in the way a page does.
 */
export default async function ControlLayout({ children }: { children: React.ReactNode }) {
  // The call is the gate; its return value is no longer needed here now that the
  // tab strip (which filtered itself by role) has moved to the rail.
  await requirePermission('control.access', '/control');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <span className="border-brand/25 bg-brand/10 text-brand inline-block rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em]">
        Operations
      </span>

      <div>{children}</div>
    </div>
  );
}
