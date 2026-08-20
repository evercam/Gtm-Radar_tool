import { Badge, Card } from '@/components/ui';
import { cn } from '@/lib/cn';
import { statusText } from '@/lib/status-colors';

export interface JourneyStep {
  status: string;
  label: string;
  /** Badge classes for the stage, from the lifecycle vocabulary. */
  badgeClass: string;
  /** How many have EVER reached this stage. */
  reached: number;
  /** How many are sitting here right now. */
  here: number;
}

/**
 * The lead journey as one card per stage.
 *
 * A FUNNEL IS A SEQUENCE, SO THE CARDS STAY IN A ROW
 *
 * The obvious way to card-ify seven stages is a wrapping grid, and it is wrong:
 * wrapped onto two lines the last stage of row one sits above the first of row
 * two, and the eye reads a grid of tiles instead of a path. Seven equal columns on
 * a wide screen keeps left-to-right meaning "later", which is the only reason the
 * order matters.
 *
 * Below `lg` it becomes two columns, because seven cards in a phone's width are
 * unreadable at any font size — there the numbers have to carry the sequence, and
 * they do, since each card names its own fall.
 *
 * THE BAR IS SHARE OF WHAT ENTERED, NOT OF THE STAGE BEFORE
 *
 * Two different questions and the card answers both: the bar is how much of the
 * whole intake survived to here, and the percentage on the card is the fall from
 * the stage immediately before. Measured today, QUEUED is a 97% fall and every
 * later bar is a sliver — the bar shows the damage is permanent, the percentage
 * shows where it happened.
 */
export default function JourneyCards({
  steps,
  entered,
  className,
}: {
  steps: JourneyStep[];
  /** The top of the funnel — denominator for the bars. */
  entered: number;
  className?: string;
}) {
  if (steps.length === 0) return null;

  return (
    <div className={cn('grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7', className)}>
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1].reached : null;
        const dropPct = prev && prev > 0 ? Math.round(((prev - s.reached) / prev) * 100) : 0;
        const share = entered > 0 ? Math.max(1, (s.reached / entered) * 100) : 0;

        return (
          <Card key={s.status} className="p-3">
            <Badge className={s.badgeClass}>{s.label}</Badge>

            <p className="text-foreground mt-2 text-base font-bold tabular-nums">{s.reached.toLocaleString()}</p>

            {/*
              Occupancy is the actionable half. "2,058 reached ENRICHING and 0 are
              here now" means it drained; "1,046 here now" means it is a queue.
              Same reached count, opposite meanings.
            */}
            <p className="text-subtle text-[10px]">
              {s.here.toLocaleString()} here now
            </p>

            <div className="bg-surface-raised border-border-base mt-2 h-1.5 overflow-hidden rounded border p-[1px]">
              <div className="bg-border-strong h-full rounded-[1px]" style={{ width: `${share}%` }} />
            </div>

            {/* Falls under 5% are not labelled — "0% lost" on a working stage is noise. */}
            <p className="mt-1.5 h-3 text-[10px] font-semibold tabular-nums">
              {dropPct >= 5 ? (
                <span className={dropPct >= 50 ? statusText.danger : statusText.warning}>−{dropPct}% here</span>
              ) : null}
            </p>
          </Card>
        );
      })}
    </div>
  );
}
