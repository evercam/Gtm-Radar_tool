'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Role } from '@/lib/auth/roles';
import { Button } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

export default function InviteUserForm({
  roles,
}: {
  /* Database rows, not the built-in six — an admin's own role must be offerable. */
  roles: { name: string; label: string; description: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(roles[0]?.name ?? 'bdr');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      const json = await res.json();
      toast.show(json.message, json.ok ? 'success' : 'error');
      if (json.ok) {
        setEmail('');
        router.refresh();
      }
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  const field = 'border-border-strong bg-surface text-foreground rounded-lg border px-3 py-2 text-sm';

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <label className="text-muted text-xs font-medium">
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@company.com"
          className={`mt-1 block w-64 ${field}`}
        />
      </label>

      <label className="text-muted text-xs font-medium">
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={`mt-1 block w-48 ${field}`}>
          {roles.map((r) => (
            <option key={r.name} value={r.name}>
              {r.label}
            </option>
          ))}
        </select>
      </label>

      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Saving…' : 'Grant access'}
      </Button>

      <p className="text-subtle w-full text-xs">{roles.find((r) => r.name === role)?.description ?? ''}</p>
    </form>
  );
}
