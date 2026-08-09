'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Badge } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

/**
 * Tokens for the MCP endpoint at /api/mcp.
 *
 * A token carries a ROLE, so it can read exactly what somebody with that role
 * can read — narrowing the role narrows every token issued against it. Minting
 * one is therefore as consequential as handing out that role, which is why the
 * picker leads with the role and not the name.
 *
 * The secret appears once, here, and is never recoverable: only its SHA-256 is
 * stored. There is no reveal button, and adding one would defeat the point of
 * hashing it. Revocation is immediate and keeps the row, so the audit trail
 * survives the revoke.
 */

export interface TokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  role: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const field =
  'border-border-strong bg-surface text-foreground rounded-lg border px-2 py-1 text-xs placeholder:text-subtle';

export default function TokenManager({
  tokens,
  roles,
  tableMissing,
}: {
  tokens: TokenRow[];
  roles: { name: string; label: string }[];
  tableMissing: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState(roles[0]?.name ?? 'bdr');
  const [fresh, setFresh] = useState<string | null>(null);

  if (tableMissing) {
    return (
      <p className="text-body text-sm">
        Run the <code className="text-xs">api_tokens</code> migration to issue tokens.
      </p>
    );
  }

  async function mint() {
    setBusy(true);
    try {
      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, role }),
      });
      const json = await res.json();
      toast.show(json.message, json.ok ? 'success' : 'error');
      if (json.ok) {
        setFresh(json.token);
        setName('');
        router.refresh();
      }
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Request failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/tokens?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const json = await res.json();
      toast.show(json.message, json.ok ? 'success' : 'error');
      if (json.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-body text-sm">
        An AI assistant can read the pipeline over HTTP at <code className="text-xs">/api/mcp</code>. A token reads only
        what its role can read, and every tool is read-only — nothing can assign, export or change a policy.
      </p>

      {fresh ? (
        <div className="border-border-base bg-surface-raised rounded-lg border px-3 py-2">
          <p className="text-foreground text-xs font-semibold">Copy this now — it cannot be shown again.</p>
          <code className="text-body mt-1 block break-all text-[11px]">{fresh}</code>
          <Button className="mt-2" onClick={() => setFresh(null)}>
            Done
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-muted text-xs">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Claude Desktop"
            className={`mt-1 block w-48 ${field}`}
          />
        </label>
        <label className="text-muted text-xs">
          Role
          <select value={role} onChange={(e) => setRole(e.target.value)} className={`mt-1 block w-44 ${field}`}>
            {roles.map((r) => (
              <option key={r.name} value={r.name}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={mint} disabled={busy || !name.trim()}>
          Create token
        </Button>
      </div>

      {tokens.length === 0 ? (
        <p className="text-subtle text-xs">No tokens yet.</p>
      ) : (
        <div className="space-y-1">
          {tokens.map((t) => (
            <div
              key={t.id}
              className="border-border-base bg-surface flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
            >
              <div className="text-xs">
                <span className="text-foreground font-semibold">{t.name}</span>
                <code className="text-subtle ml-2 text-[11px]">{t.tokenPrefix}…</code>
                <Badge className="ml-2">{t.role}</Badge>
                {t.revokedAt ? <span className="text-muted ml-2">revoked</span> : null}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-subtle text-[11px]">
                  {t.lastUsedAt ? `last used ${t.lastUsedAt.slice(0, 10)}` : 'never used'}
                </span>
                {!t.revokedAt ? (
                  <Button onClick={() => revoke(t.id)} disabled={busy}>
                    Revoke
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
