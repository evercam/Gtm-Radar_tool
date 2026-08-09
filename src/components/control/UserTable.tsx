'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Role } from '@/lib/auth/roles';
import type { UserProfile } from '@/lib/auth/users';
import { Table, THead, TBody, Th, Td, Badge } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

/**
 * Inline role and activation editing. The last-admin rule is enforced by the
 * API — this only reflects the outcome, so the guard cannot be bypassed by
 * editing the page.
 */
export default function UserTable({
  users,
  currentUserId,
  roles,
}: {
  users: UserProfile[];
  currentUserId: string;
  /* Passed in rather than imported: roles are database rows, so a hard-coded
     list here would silently hide every role an admin defines. */
  roles: { name: string; label: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function patch(id: string, body: Record<string, unknown>) {
    setBusyId(id);
    try {
      const res = await fetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...body }),
      });
      const json = await res.json();
      toast.show(json.message, json.ok ? 'success' : 'error');
      if (json.ok) router.refresh();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <tr>
            <Th>User</Th>
            <Th>Role</Th>
            <Th>Scope</Th>
            <Th>Status</Th>
            <Th align="right">Actions</Th>
          </tr>
        </THead>
        <TBody>
          {users.map((u) => (
            <tr key={u.id}>
              <Td>
                <span className="text-foreground block font-medium">{u.fullName || '—'}</span>
                <span className="text-muted block text-xs">{u.email}</span>
                {u.id === currentUserId ? <span className="text-subtle text-[11px]">you</span> : null}
              </Td>
              <Td>
                <select
                  value={u.role}
                  disabled={busyId === u.id}
                  onChange={(e) => patch(u.id, { role: e.target.value as Role })}
                  className="border-border-strong bg-surface text-foreground rounded-lg border px-2 py-1 text-xs"
                >
                  {roles.map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Td>
              <Td>
                <span className="text-muted text-xs">
                  {u.bu.length ? u.bu.join(', ').toUpperCase() : 'All BUs'}
                  {u.verticals.length ? ` · ${u.verticals.length} verticals` : ''}
                </span>
              </Td>
              <Td>
                <Badge tone={u.isActive ? 'success' : 'neutral'}>{u.isActive ? 'Active' : 'Disabled'}</Badge>
              </Td>
              <Td align="right">
                <button
                  disabled={busyId === u.id}
                  onClick={() => patch(u.id, { is_active: !u.isActive })}
                  className="text-brand text-xs underline disabled:opacity-50"
                >
                  {u.isActive ? 'Disable' : 'Enable'}
                </button>
              </Td>
            </tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
