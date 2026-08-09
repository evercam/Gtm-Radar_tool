'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Badge } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

/**
 * Define a role, and choose what it can do.
 *
 * The one thing this screen must not do is lie. An admin can invent a
 * permission name here, and the tool will store it, offer it, and let it be
 * ticked onto a role — but nothing in the codebase reads a name it does not
 * already check, so it grants precisely nothing. Every unenforced permission is
 * therefore labelled as such, in the picker and on the role, rather than sitting
 * quietly among the real ones and making a role look more powerful than it is.
 *
 * The API enforces the rules that matter — built-in roles cannot be deleted, a
 * role in use cannot be deleted, and the last role holding `users.manage`
 * cannot lose it. This only reflects the outcome, so none of them can be
 * bypassed by editing the page.
 */

export interface RoleRow {
  name: string;
  label: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
  userCount?: number;
}

export interface PermissionRow {
  name: string;
  label: string;
  description: string;
  isEnforced: boolean;
}

const field =
  'border-border-strong bg-surface text-foreground rounded-lg border px-2 py-1 text-xs placeholder:text-subtle';

export default function RoleManager({ roles, permissions }: { roles: RoleRow[]; permissions: PermissionRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [newRole, setNewRole] = useState({ name: '', label: '', description: '' });
  const [custom, setCustom] = useState('');

  const unenforced = permissions.filter((p) => !p.isEnforced);

  async function send(method: 'POST' | 'PATCH' | 'DELETE', body?: unknown, query = '') {
    setBusy(true);
    try {
      const res = await fetch(`/api/roles${query}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      toast.show(json.message, json.ok ? 'success' : 'error');
      if (json.ok) {
        setEditing(null);
        setCreating(false);
        setNewRole({ name: '', label: '', description: '' });
        router.refresh();
      }
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Request failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  function startEdit(r: RoleRow) {
    setEditing(r.name);
    setDraft([...r.permissions]);
  }

  const toggle = (name: string) =>
    setDraft((d) => (d.includes(name) ? d.filter((x) => x !== name) : [...d, name]));

  return (
    <div className="space-y-4">
      {unenforced.length > 0 ? (
        <p className="border-border-base bg-surface-raised text-body rounded-lg border px-3 py-2 text-xs">
          <span className="text-foreground font-semibold">{unenforced.length} permission(s) are not enforced.</span>{' '}
          They can be assigned, and they change nothing until code ships that checks them:{' '}
          <code className="text-[11px]">{unenforced.map((p) => p.name).join(', ')}</code>
        </p>
      ) : null}

      <div className="space-y-2">
        {roles.map((r) => {
          const isEditing = editing === r.name;
          const held = isEditing ? draft : r.permissions;
          const inert = held.filter((p) => !permissions.find((x) => x.name === p)?.isEnforced);
          return (
            <div key={r.name} className="border-border-base bg-surface rounded-xl border px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="text-foreground text-sm font-semibold">{r.label}</span>
                  <code className="text-subtle ml-2 text-[11px]">{r.name}</code>
                  {r.isSystem ? <Badge className="ml-2">built-in</Badge> : null}
                  {typeof r.userCount === 'number' ? (
                    <span className="text-muted ml-2 text-[11px]">{r.userCount} user(s)</span>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => (isEditing ? setEditing(null) : startEdit(r))} disabled={busy}>
                    {isEditing ? 'Cancel' : 'Edit permissions'}
                  </Button>
                  {!r.isSystem ? (
                    <Button
                      onClick={() => send('DELETE', undefined, `?name=${encodeURIComponent(r.name)}`)}
                      disabled={busy}
                    >
                      Delete
                    </Button>
                  ) : null}
                </div>
              </div>
              <p className="text-muted mt-0.5 text-xs">{r.description}</p>

              {inert.length > 0 && !isEditing ? (
                <p className="text-muted mt-1 text-[11px]">
                  {inert.length} of these grant nothing yet: <code>{inert.join(', ')}</code>
                </p>
              ) : null}

              {isEditing ? (
                <>
                  <div className="mt-3 grid gap-1 sm:grid-cols-2">
                    {permissions.map((p) => (
                      <label key={p.name} className="text-body flex items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={draft.includes(p.name)}
                          onChange={() => toggle(p.name)}
                          className="mt-0.5"
                        />
                        <span>
                          {p.label}
                          <code className="text-subtle ml-1 text-[10px]">{p.name}</code>
                          {!p.isEnforced ? <span className="text-muted ml-1">· not enforced</span> : null}
                        </span>
                      </label>
                    ))}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      value={custom}
                      onChange={(e) => setCustom(e.target.value)}
                      placeholder="add a custom permission, e.g. exports.approve"
                      className={`w-72 ${field}`}
                    />
                    <Button
                      onClick={() => {
                        const name = custom.trim().toLowerCase();
                        if (!name) return;
                        if (!draft.includes(name)) setDraft((d) => [...d, name]);
                        setCustom('');
                      }}
                      disabled={busy}
                    >
                      Add
                    </Button>
                    <span className="text-subtle text-[11px]">A new name grants nothing until code checks it.</span>
                  </div>

                  <div className="mt-3">
                    <Button onClick={() => send('PATCH', { name: r.name, permissions: draft })} disabled={busy}>
                      Save {draft.length} permission(s)
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-subtle mt-1 text-[11px]">{r.permissions.join(' · ') || 'no permissions'}</p>
              )}
            </div>
          );
        })}
      </div>

      {creating ? (
        <div className="border-border-base bg-surface rounded-xl border px-4 py-3">
          <div className="flex flex-wrap gap-2">
            <input
              value={newRole.name}
              onChange={(e) => setNewRole({ ...newRole, name: e.target.value })}
              placeholder="name (e.g. nhs_desk)"
              className={`w-48 ${field}`}
            />
            <input
              value={newRole.label}
              onChange={(e) => setNewRole({ ...newRole, label: e.target.value })}
              placeholder="Label (e.g. NHS Desk)"
              className={`w-56 ${field}`}
            />
            <input
              value={newRole.description}
              onChange={(e) => setNewRole({ ...newRole, description: e.target.value })}
              placeholder="What this role is for"
              className={`w-72 ${field}`}
            />
          </div>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => send('POST', { ...newRole, permissions: [] })} disabled={busy}>
              Create
            </Button>
            <Button onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
          <p className="text-subtle mt-2 text-[11px]">
            Created with no permissions — add them with “Edit permissions”, so a new role never starts out able to do
            more than intended.
          </p>
        </div>
      ) : (
        <Button onClick={() => setCreating(true)} disabled={busy}>
          New role
        </Button>
      )}
    </div>
  );
}
