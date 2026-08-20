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
 * A component because the dashboard and /control/routing both drew this, each
 * with its own copy of the markup and its own copy of the legend. Two copies of
 * a chart is how the same lane ends up two widths on two screens.
 *
 * The bars follow the dataviz mark specs the hand-rolled version missed:
 *
 *   rounded data-ends, anchored to the baseline. The fill was a plain rectangle,
 *     so a lane holding four records and a lane holding four thousand differed
 *     only in length — nothing said which end was the measured one.
 *   a 2px surface gap around the fill, so a bar that nearly fills its track is
 *     still visibly a bar inside a track rather than a solid block.
 *   a minimum width for a non-zero count. A lane with records must never render
 *     as an empty track: zero and nearly-zero are different answers and the
 *     chart has to say so.
 *   a hover layer, which the skill asks for by default. Here it is the native
 *     title, deliberately: this renders on the server inside a page that streams,
 *     and a JS tooltip would mean making the whole panel a client component to
 *     add a number the row already shows.
 *
 * Identity is never colour alone — every row carries its route and stage as text
 * beside the bar, which is also the relief the validator's contrast WARN requires.
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
    <div className={cn('space-y-2.5', className)}>
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
            className="group focus-visible:outline-brand flex items-center gap-3 rounded focus-visible:outline-2 focus-visible:outline-offset-2"
            title={`${lane} — ${l.count.toLocaleString()} record${l.count === 1 ? '' : 's'}, ${pct}% of routed`}
          >
            <div className="w-36 shrink-0 text-[11px]">
              <span className={cn('font-bold group-hover:underline', laneText[l.route] ?? 'text-muted')}>
                {l.route}
              </span>
              <span className="text-subtle"> / {l.stage}</span>
            </div>

            {/* The 2px inset is the surface gap; the track is the full domain. */}
            <div className="bg-surface-raised border-border-base h-4 flex-1 overflow-hidden rounded border p-[2px]">
              <div
                className={cn('h-full rounded-[3px] transition-[width] duration-300', laneBar[lane] ?? 'bg-zinc-400')}
                style={{ width: `${width}%` }}
              />
            </div>

            <div className="text-foreground w-24 shrink-0 text-right text-[11px] font-bold tabular-nums">
              {l.count.toLocaleString()}
              <span className="text-subtle ml-1 font-normal">{pct}%</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
