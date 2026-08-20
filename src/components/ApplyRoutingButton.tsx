'use client';

import { useState } from 'react';
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
      <button
        onClick={apply}
        disabled={busy}
        className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy ? 'Scoring & routing all records…' : 'Score & route all records →'}
      </button>
      {msg ? (
        <span
          className={`text-xs ${msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
        >
          {msg.text}
        </span>
      ) : null}
    </div>
  );
}
