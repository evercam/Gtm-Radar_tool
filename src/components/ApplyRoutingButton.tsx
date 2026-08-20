'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import { statusText } from '@/lib/status-colors';
import { useRouter } from 'next/navigation';

export default function ApplyRoutingButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function apply() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/routing/apply', { method: 'POST' });
      const json = await res.json();
      setMsg({ ok: json.ok, text: json.message });
      if (json.ok) router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Button variant="success" onClick={apply} disabled={busy}>
        {busy ? 'Scoring & routing all records…' : 'Score & route all records →'}
      </Button>
      {msg ? (
        <span className={cn('text-xs', statusText[msg.ok ? 'success' : 'danger'])}>
          {msg.text}
        </span>
      ) : null}
    </div>
  );
}
