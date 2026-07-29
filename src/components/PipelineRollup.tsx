import Link from 'next/link';
import type { PipelineRollupRow } from '@/lib/queries';
import { BU_LABELS } from '@/lib/semantics';

function titleize(v: string): string {
  return v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Renders the BU × vertical × contact-status rollup of canonical_projects.
 * Server component — receives already-aggregated rows so it stays presentational.
 */
export default function PipelineRollup({ rows }: { rows: PipelineRollupRow[] }) {
  const total = rows.reduce((s, r) => s + r.count, 0);

  if (total === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border-strong bg-surface p-8 text-center">
        <p className="text-sm font-medium text-foreground">No leads ingested yet.</p>
        <p className="mt-1 text-sm text-muted">
          Run a source from{' '}
          <Link href="/control/sources" className="underline underline-offset-2">
            /search
          </Link>{' '}
          or load{' '}
          <Link href="/control/sources" className="underline underline-offset-2">
            GEM trackers
          </Link>
          , then ingest to populate this view.
        </p>
      </div>
    );
  }

  const needs = rows.filter((r) => r.contact_status === 'needs_enrichment').reduce((s, r) => s + r.count, 0);
  const has = total - needs;
  const bus = new Set(rows.map((r) => r.bu)).size;
  const verticals = new Set(rows.map((r) => r.vertical)).size;

  // pivot to (bu, vertical) -> { has, needs }
  const pivot = new Map<string, { bu: string; vertical: string; has: number; needs: number }>();
  for (const r of rows) {
    const key = `${r.bu}|${r.vertical}`;
    const p = pivot.get(key) ?? { bu: r.bu, vertical: r.vertical, has: 0, needs: 0 };
    if (r.contact_status === 'needs_enrichment') p.needs += r.count;
    else p.has += r.count;
    pivot.set(key, p);
  }
  const grid = Array.from(pivot.values()).sort(
    (a, b) => a.bu.localeCompare(b.bu) || b.has + b.needs - (a.has + a.needs)
  );

  const stats = [
    { label: 'Total leads', value: total },
    { label: 'Have a contact', value: has, tone: 'ok' as const },
    { label: 'Need enrichment', value: needs, tone: 'gap' as const },
    { label: 'BUs · verticals', value: `${bus} · ${verticals}` },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-[12px] border border-border-base bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">{s.label}</p>
            <p
              className={`mt-1 text-2xl font-semibold tabular-nums ${
                s.tone === 'ok'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : s.tone === 'gap'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-foreground'
              }`}
            >
              {s.value}
            </p>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border-base bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface-raised text-xs uppercase text-muted">
            <tr>
              <th className="px-4 py-2">Business unit</th>
              <th className="px-4 py-2">Vertical</th>
              <th className="px-4 py-2 text-right">Has contact</th>
              <th className="px-4 py-2 text-right">Needs enrichment</th>
              <th className="px-4 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-base">
            {grid.map((r) => (
              <tr key={`${r.bu}-${r.vertical}`}>
                <td className="px-4 py-2 font-medium text-foreground">{BU_LABELS[r.bu] ?? r.bu}</td>
                <td className="px-4 py-2 text-muted">{titleize(r.vertical)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {r.has || '—'}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">
                  {r.needs || '—'}
                </td>
                <td className="px-4 py-2 text-right font-medium tabular-nums text-foreground">{r.has + r.needs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
