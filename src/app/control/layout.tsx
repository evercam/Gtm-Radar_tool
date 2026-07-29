import { requirePermission } from '@/lib/auth/session';
import { ROLE_PERMISSIONS } from '@/lib/auth/roles';
import ControlTabs from '@/components/control/ControlTabs';

/**
 * Shared frame for the Control Center.
 *
 * Every operator surface gets the same header and tab strip, so they read as
 * one console. The `control.access` check here is a floor, not the whole
 * gate — each page still asserts its own, more specific permission, because a
 * layout does not re-run on every navigation in the way a page does.
 */
export default async function ControlLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePermission('control.access', '/control');
  const allowed = ROLE_PERMISSIONS[user.role];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <span className="border-brand/25 bg-brand/10 text-brand inline-block rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em]">
        Operations
      </span>

      <ControlTabs set="operations" allowed={allowed} />

      <div>{children}</div>
    </div>
  );
}
