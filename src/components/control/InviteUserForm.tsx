'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, type Role } from '@/lib/auth/roles';
import { Button } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

export default function InviteUserForm() {
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('bdr');
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
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </label>

      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Saving…' : 'Grant access'}
      </Button>

      <p className="text-subtle w-full text-xs">{ROLE_DESCRIPTIONS[role]}</p>
    </form>
  );
}
