'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PRIORITY_BANDS } from '@/lib/priority';

interface BatchResult {
  id: string;
  name: string;
  ok: boolean;
  account: string | null;
  contacts: number;
  fields: number;
  message?: string;
}
interface BatchResponse {
  ok: boolean;
  dryRun?: boolean;
  message: string;
  requested?: number;
  succeeded?: number;
  failed?: number;
  contactsFound?: number;
  fieldsAdded?: number;
  queueTotal?: number;
  durationMs?: number;
  results?: BatchResult[];
}

const BUS = ['usa', 'uk', 'ireland', 'apac', 'export'];
const ROUTES = ['sales', 'marketing', 'partner'];

/**
 * The spend control. Narrows the queue, previews the cost with a dry run, then
 * commits. Every bound (max batch, min priority, daily cap) is enforced
 * server-side from the policy — this only ever narrows what is already allowed.
 */
export default function EnrichmentRunner({
  defaultBatchSize,
  maxBatchSize,
}: {
  defaultBatchSize: number;
  maxBatchSize: number;
}) {
  const router = useRouter();
  const [bu, setBu] = useState('');
  const [route, setRoute] = useState('');
  const [band, setBand] = useState('');
  const [limit, setLimit] = useState(defaultBatchSize);
  const [busy, setBusy] = useState<'run' | 'dry' | null>(null);
  const [res, setRes] = useState<BatchResponse | null>(null);

  async function submit(dryRun: boolean) {
    setBusy(dryRun ? 'dry' : 'run');
    setRes(null);
    try {
      const r = await fetch('/api/enrich/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bu: bu || undefined,
          route: route || undefined,
          band: band || undefined,
          limit,
          dryRun,
        }),
      });
      const json = (await r.json()) as BatchResponse;
      setRes(json);
      if (json.ok && !dryRun) router.refresh();
    } catch (e) {
      setRes({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  const select = 'mt-1 block rounded border border-border-strong bg-surface px-2 py-1.5 text-sm text-foreground';

  return (
    <div className="rounded-[12px] border border-border-base bg-surface p-5">
      <h2 className="text-sm font-semibold text-foreground">Run a batch</h2>
      <p className="mt-1 text-xs text-muted">
        Works the queue top-down in priority order. Dry run first to see exactly which records would be spent on.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="text-xs font-medium text-muted">
          Business unit
          <select value={bu} onChange={(e) => setBu(e.target.value)} className={`${select} w-32`}>
            <option value="">All</option>
            {BUS.map((b) => (
              <option key={b} value={b}>
                {b.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-muted">
          Lane
          <select value={route} onChange={(e) => setRoute(e.target.value)} className={`${select} w-32`}>
            <option value="">All</option>
            {ROUTES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-muted">
          Band
          <select value={band} onChange={(e) => setBand(e.target.value)} className={`${select} w-28`}>
            <option value="">Policy default</option>
            {PRIORITY_BANDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-muted">
          Records
          <input
            type="number"
            min={1}
            max={maxBatchSize}
            value={limit}
            onChange={(e) => setLimit(Math.max(1, Math.min(maxBatchSize, Number(e.target.value) || 1)))}
            className={`${select} w-24`}
          />
        </label>

        <button
          onClick={() => submit(true)}
          disabled={busy !== null}
          className="rounded border border-border-strong px-3 py-2 text-sm font-medium text-muted hover:bg-surface-raised disabled:opacity-50-raised"
        >
          {busy === 'dry' ? 'Checking…' : 'Dry run'}
        </button>
        <button
          onClick={() => submit(false)}
          disabled={busy !== null}
          className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy === 'run' ? `Enriching ${limit}…` : `Enrich ${limit} records →`}
        </button>
      </div>

      {res ? (
        <div className="mt-4">
          <p
            className={`text-sm ${res.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
          >
            {res.dryRun ? 'Dry run — nothing spent. ' : ''}
            {res.message}
            {res.durationMs ? <span className="text-subtle"> ({Math.round(res.durationMs / 1000)}s)</span> : null}
          </p>
          {res.results && res.results.length > 0 ? (
            <div className="mt-3 max-h-72 overflow-y-auto rounded border border-border-base">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface-raised text-muted">
                  <tr>
                    <th className="px-3 py-1.5">Record</th>
                    <th className="px-3 py-1.5">Account resolved</th>
                    <th className="px-3 py-1.5 text-right">Contacts</th>
                    <th className="px-3 py-1.5 text-right">Fields</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-base">
                  {res.results.map((r) => (
                    <tr key={r.id} className={r.ok ? '' : 'bg-rose-50/50 dark:bg-rose-950/20'}>
                      <td className="px-3 py-1.5 text-foreground">{r.name}</td>
                      <td className="px-3 py-1.5 text-muted">
                        {r.ok ? (
                          (r.account ?? <span className="text-subtle">not resolved</span>)
                        ) : (
                          <span className="text-rose-600 dark:text-rose-400">{r.message}</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted">{r.contacts}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted">{r.fields}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
