import Link from 'next/link';
import { laneBar, laneText } from '@/lib/status-colors';
import { cn } from '@/lib/cn';

export interface LaneRow {
  route: string;
  stage: string;
  count: number;
}

/**
 * Where the routed work landed, as a bar per lane.
 *
 * A component because the dashboard and /control/routing both drew this, each with
 * its own copy of the markup and its own copy of the legend.
 *
 * THE LABEL SITS ABOVE THE BAR, NOT BESIDE IT
 *
 * The first version put them on one line with a w-36 label and a w-24 value and
 * `flex-1` between. That is 264px of fixed width before the bar gets anything, and
 * on the dashboard this panel lives in a 4-of-12 column about 180px wide. flex-1
 * resolved to zero and every bar rendered as its 3% minimum — four identical 8px
 * squares where the lengths were supposed to be the whole point. It looked
 * deliberate, which is why it survived review and only fell over when someone
 * actually opened the page.
 *
 * Stacking removes the constraint instead of tuning it: the track is always the
 * full width of whatever column it is given, so the same component works in a
 * quarter-width tile and in a full-width card without a breakpoint.
 *
 * The rest follows the dataviz mark specs: rounded data-ends anchored to the
 * baseline, a 2px surface gap so a nearly-full bar still reads as a bar inside a
 * track, and a minimum width for any non-zero count — a lane holding records must
 * never render as an empty track, because zero and nearly-zero are different
 * answers.
 *
 * Identity is never colour alone; every row names its route and stage, which is
 * also the relief the validator's contrast WARN requires.
 */
export default function LaneChart({
  rows,
  total,
  className,
}: {
  rows: LaneRow[];
  /** Denominator for the percentages. The caller owns it — it is routed, not summed here. */
  total: number;
  className?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <div className={cn('space-y-3', className)}>
      {rows.map((l) => {
        const lane = `${l.route}/${l.stage}`;
        const pct = total > 0 ? Math.round((l.count / total) * 100) : 0;
        /*
          Width is share OF THE LARGEST LANE, not of the total — the bar answers
          "how do these compare", and against the total every lane but the biggest
          collapses into a sliver. The percentage beside it is of the total, which
          is the other question, and it is a number rather than a length.
        */
        const width = l.count === 0 ? 0 : Math.max(3, (l.count / max) * 100);

        return (
          <Link
            key={lane}
            href={`/records?route=${l.route}&stage=${l.stage}`}
            prefetch={false}
            className="group focus-visible:outline-brand block rounded focus-visible:outline-2 focus-visible:outline-offset-2"
            title={`${lane} — ${l.count.toLocaleString()} record${l.count === 1 ? '' : 's'}, ${pct}% of routed`}
          >
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate">
                <span className={cn('font-bold group-hover:underline', laneText[l.route] ?? 'text-muted')}>
                  {l.route}
                </span>
                <span className="text-subtle"> / {l.stage}</span>
              </span>
              <span className="text-foreground shrink-0 font-bold tabular-nums">
                {l.count.toLocaleString()}
                <span className="text-subtle ml-1 font-normal">{pct}%</span>
              </span>
            </div>

            {/* The 2px inset is the surface gap; the track is the full domain. */}
            <div className="bg-surface-raised border-border-base mt-1 h-2.5 overflow-hidden rounded border p-[2px]">
              <div
                className={cn('h-full rounded-[2px] transition-[width] duration-300', laneBar[lane] ?? 'bg-zinc-400')}
                style={{ width: `${width}%` }}
              />
            </div>
          </Link>
        );
      })}
    </div>
  );
}
