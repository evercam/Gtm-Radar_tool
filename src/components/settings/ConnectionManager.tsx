'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Badge } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

/**
 * Assistants somebody has connected over OAuth.
 *
 * The counterpart to TokenManager, and deliberately NOT the same thing. A token
 * is minted here, by an admin, and carries a role. A connection appears when a
 * colleague approves a client on the consent screen, and carries their identity —
 * so this list is not a set of credentials to manage but a record of who has
 * connected what, with the ability to cut any of it off.
 *
 * Nothing is created from this screen for the same reason: a connection can only
 * come into being through a person's own approval. There is no "add" button
 * because there is nothing an admin could usefully press.
 */

export interface ConnectionRow {
  clientId: string;
  clientName: string;
  userId: string;
  email: string | null;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export default function ConnectionManager({
  connections,
  tableMissing,
}: {
  connections: ConnectionRow[];
  tableMissing: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (tableMissing) {
    return (
      <p className="text-body text-sm">
        Run the <code className="text-xs">mcp_oauth</code> migration before an assistant can connect this way.
      </p>
    );
  }

  async function revoke(clientId: string, userId: string) {
    setBusy(true);
    try {
      const res = await fetch('/api/oauth/connections', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, userId }),
      });
      const json = await res.json();
      toast.show(json.message, json.ok ? 'success' : 'error');
      if (json.ok) router.refresh();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Request failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (connections.length === 0) {
    return <p className="text-subtle text-xs">Nothing connected yet.</p>;
  }

  return (
    <div className="space-y-1">
      {connections.map((c) => (
        <div
          key={`${c.clientId}:${c.userId}`}
          className="border-border-base bg-surface flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
        >
          <div className="text-xs">
            <span className="text-foreground font-semibold">{c.clientName}</span>
            {/* The person is the important half — this is their access, not the
                client's, and it is their role that decides what it reads. */}
            <span className="text-muted ml-2">as {c.email ?? c.userId}</span>
            <Badge className="ml-2">{c.scope}</Badge>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-subtle text-[11px]">
              {c.lastUsedAt ? `last used ${c.lastUsedAt.slice(0, 10)}` : `connected ${c.createdAt.slice(0, 10)}`}
            </span>
            <Button onClick={() => revoke(c.clientId, c.userId)} disabled={busy}>
              Disconnect
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
