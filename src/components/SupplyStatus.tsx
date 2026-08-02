import { Card, CardHeader, CardBody, Badge, ProgressBar } from '@/components/ui';
import type { ProductionState } from '@/lib/queries';
import type { DemandPlan } from '@/lib/enrich/demand';

/**
 * Are we making the month's leads, and does each person have enough to work on?
 *
 * Two questions that look like one and are not. The month's total can be on
 * track while somebody scoped to a narrow vertical has nothing to call — the
 * aggregate hides them, because their share is small by construction. So the bar
 * answers the first and the table answers the second, and neither is allowed to
 * stand in for the other.
 *
 * Days of cover rather than a lead count, because "7 leads" means nothing until
 * you know they burn 10 a day.
 */

function coverTone(days: number, hasQuota: boolean): 'success' | 'warning' | 'danger' | 'neutral' {
  if (!hasQuota) return 'neutral';
  // Under a day is out of work tomorrow morning; under three is inside the time
  // it takes a refill to arrive.
  if (days < 1) return 'danger';
  if (days < 3) return 'warning';
  return 'success';
}

function coverLabel(days: number, hasQuota: boolean): string {
  if (!hasQuota) return 'no quota set';
  if (days < 0.1) return 'nothing queued';
  if (days < 1) return 'less than a day';
  if (days < 2) return '1 day';
  return `${Math.round(days)} days`;
}

/** Pace: where the month SHOULD be by now, so "on track" is answerable. */
function expectedByNow(target: number, now: Date): number {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOfMonth = now.getUTCDate();
  return Math.round((target / daysInMonth) * dayOfMonth);
}

export default function SupplyStatus({
  production,
  plan,
  now = new Date(),
}: {
  production: ProductionState;
  plan: DemandPlan;
  now?: Date;
}) {
  const { produced, target, remaining, dailyDemand } = production;
  const expected = expectedByNow(target, now);
  // Ahead or behind PACE, not just against the total — 1,000 of 7,200 is fine on
  // the fifth and a crisis on the twenty-fifth, and a bare percentage cannot tell
  // you which.
  const behind = Math.max(0, expected - produced);
  const onTrack = target === 0 || produced >= expected;
  const daysLeft =
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate() - now.getUTCDate();
  const neededPerDay = daysLeft > 0 ? Math.ceil(remaining / daysLeft) : remaining;

  return (
    <Card>
      <CardHeader
        title="Lead supply"
        subtitle={`${produced.toLocaleString()} of ${target.toLocaleString()} enriched this month`}
        action={
          target === 0 ? (
            <Badge>no monthly target set</Badge>
          ) : onTrack ? (
            <Badge tone="success">on track</Badge>
          ) : (
            <Badge tone="warning">{behind.toLocaleString()} behind pace</Badge>
          )
        }
      />
      <CardBody className="space-y-5">
        <div>
          <ProgressBar value={produced} max={Math.max(1, target)} tone={onTrack ? 'success' : 'warning'} />
          <div className="text-subtle mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[11px]">
            <span>
              {target > 0 ? Math.round((produced / target) * 100) : 0}% of the month
              {target > 0 ? ` · pace says ${expected.toLocaleString()} by today` : ''}
            </span>
            <span>
              {remaining > 0
                ? `${remaining.toLocaleString()} to go · ${neededPerDay.toLocaleString()}/day for the ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
                : 'Target met — enrichment paused until the 1st'}
            </span>
          </div>
        </div>

        {/*
          The team's own runway. A person is listed even at zero, because an
          empty row is the signal — somebody with nothing queued is the thing
          this panel exists to surface, and hiding them would defeat it.
        */}
        {plan.people.length === 0 ? (
          <p className="text-subtle text-xs">
            Nobody active on the roster has a daily lead quota, so there is no demand to measure against. Set quotas on
            the Team page.
          </p>
        ) : (
          <div>
            <div className="text-subtle mb-2 text-[11px] font-medium uppercase tracking-wide">Days of leads in hand</div>
            <ul className="space-y-2">
              {[...plan.people]
                .sort((a, b) => a.daysOfCover - b.daysOfCover)
                .map((p) => {
                  const hasQuota = p.dailyQuota > 0;
                  const tone = coverTone(p.daysOfCover, hasQuota);
                  return (
                    <li key={p.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-foreground truncate text-xs font-medium">{p.name}</span>
                          <span className="text-subtle shrink-0 text-[10px]">
                            {hasQuota ? `${p.dailyQuota}/day` : 'no quota'}
                            {p.scope.verticals.length ? ` · ${p.scope.verticals.join(', ')}` : ''}
                            {p.scope.regions.length ? ` · ${p.scope.regions.join(', ')}` : ''}
                          </span>
                        </div>
                        {/* Capped at a week so one well-stocked person does not
                            flatten everybody else's bar into invisibility. */}
                        <ProgressBar value={Math.min(p.daysOfCover, 7)} max={7} tone={tone} className="mt-1" />
                      </div>
                      <div className="text-right">
                        <Badge tone={tone}>{coverLabel(p.daysOfCover, hasQuota)}</Badge>
                        <div className="text-subtle mt-0.5 text-[10px]">{p.covered.toLocaleString()} ready</div>
                      </div>
                    </li>
                  );
                })}
            </ul>
            <p className="text-subtle mt-3 text-[10px]">
              Team draws {dailyDemand.toLocaleString()} a day. Cover counts leads whose vertical, region and business
              unit that person can actually be given — not the pool as a whole.
            </p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
