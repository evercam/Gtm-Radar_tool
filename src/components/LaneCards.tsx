import Link from 'next/link';
import { laneBar, laneText } from '@/lib/status-colors';
import { cn } from '@/lib/cn';
import { Card } from '@/components/ui';
import type { LaneRow } from './LaneChart';

/**
 * The routed lanes as metric cards.
 *
 * WHY THIS EXISTS ALONGSIDE LaneChart
 *
 * Not a second copy of the chart — a different form for a different job, sharing
 * the same vocabulary. Both read `laneBar`/`laneText`, so a lane cannot be one
 * colour here and another there; only the shape differs.
 *
 * /control/routing previews a rule set that can produce any number of lanes,
 * including ones with nothing in them, and comparing a long list is what a bar
 * chart is for. The dashboard shows the four lanes that actually materialised, and
 * at four the figures are worth reading as figures.
 *
 * THE SHARE BAR IS NOT DECORATION
 *
 * Four equal-sized cards say four equal-looking things. The real spread is
 * 42,560 against 459 — a factor of 93 — and a card grid flattens exactly the
 * comparison a bar chart existed to make. So each card keeps a thin bar scaled to
 * the LARGEST lane, which is the one thing the numbers alone cannot show at a
 * glance: that act_now is a rounding error beside nurture.
 *
 * The lane hue goes on the bar, never on the figure. The hue is categorical — which
 * desk owns this — and a coloured number would read as a status, which is the
 * confusion status-colors.ts exists to prevent.
 */
export default function LaneCards({
  rows,
  total,
  className,
}: {
  rows: LaneRow[];
  /** Denominator for the percentages — routed, not summed here. */
  total: number;
  className?: string;
}) {
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <div className={cn('grid grid-cols-12 gap-4', className)}>
      {rows.map((l) => {
        const lane = `${l.route}/${l.stage}`;
        const pct = total > 0 ? Math.round((l.count / total) * 100) : 0;
        const width = l.count === 0 ? 0 : Math.max(3, (l.count / max) * 100);

        return (
          <Link
            key={lane}
            href={`/records?route=${l.route}&stage=${l.stage}`}
            prefetch={false}
            className="col-span-6 block lg:col-span-3"
          >
            <Card interactive className="h-full p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest">
                <span className={laneText[l.route] ?? 'text-muted'}>{l.route}</span>
                <span className="text-subtle"> / {l.stage}</span>
              </p>
              <p className="text-foreground mt-1.5 text-xl font-bold tabular-nums">{l.count.toLocaleString()}</p>
              <p className="text-subtle mt-0.5 text-[10px]">
                {/*
                  Percent of routed, spelled out. "42%" alone invites the reader to
                  assume it is a share of everything, and 10,358 records are not
                  routed at all.
                */}
                {pct}% of routed
              </p>
              <div className="bg-surface-raised border-border-base mt-2 h-1.5 overflow-hidden rounded border p-[1px]">
                <div
                  className={cn('h-full rounded-[1px]', laneBar[lane] ?? 'bg-zinc-400')}
                  style={{ width: `${width}%` }}
                />
              </div>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}
