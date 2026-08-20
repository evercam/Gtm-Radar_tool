import Link from 'next/link';
import { AlertTriangle, ArrowDown, ArrowUp, Minus } from 'lucide-react';
import type { DemandPlan } from '@/lib/enrich/demand';
import type { HandoverBreakdown, ProductionState } from '@/lib/queries';
import { Badge, Card, CardBody, CardHeader, ProgressBar, Table, TBody, THead, Th, Td } from '@/components/ui';
import { cn } from '@/lib/cn';
import { statusText } from '@/lib/status-colors';

/**
 * Supply and the people it is for, in one panel.
 *
 * This was three: Lead supply, Team coverage, and Handover by person. They sat in
 * two rows and answered one question between them — is there enough work, is it
 * reaching people, and is anybody about to run out — so a reader had to hold three
 * panels in their head and join them on names. Worse, all three are keyed on the
 * same five people, so the join was real work the page was making a human do.
 *
 * Now the header is the month (the only aggregate) and the table is the people,
 * with the supply columns and the handover columns side by side. "Jose has 2 in
 * stock, burns 25 a day, and 37 of what he received is still waiting on a contact"
 * is one row instead of three lookups.
 *
 * ONE BOUNDARY, DELIBERATELY
 *
 * Handover used to stream on its own because it pages the whole assigned book.
 * Measured after the rollup migration: 2.0s for handover, 1.1s for production,
 * 0.25s for the plan. All three behind one boundary costs about two seconds on a
 * panel below the fold, and buys a table that is never half-populated — which is
 * the failure a merged panel with two boundaries would have.
 */

/**
 * Where the thresholds come from.
 *
 * Under a day means they idle today. Three days is the demand plan's own floor —
 * see PersonDemand.floor, three days of their own draw. A week is comfortable.
 * The plan's numbers, not new policy invented to justify a colour.
 */
const COVER_BANDS = [
  { max: 1, tone: 'danger', label: 'idle today', Icon: AlertTriangle },
  { max: 3, tone: 'warning', label: 'below floor', Icon: ArrowDown },
  { max: 7, tone: 'neutral', label: 'thin', Icon: Minus },
  { max: Infinity, tone: 'success', label: 'on track', Icon: ArrowUp },
] as const;

const coverBand = (days: number) => COVER_BANDS.find((b) => days < b.max) ?? COVER_BANDS[COVER_BANDS.length - 1];

/** Pace, not progress: 1,000 of 7,200 is fine on the 5th and a crisis on the 25th. */
function expectedByNow(target: number, now: Date): number {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.round((target * now.getUTCDate()) / daysInMonth);
}

export default function TeamSupply({
  production,
  plan,
  handover,
  now = new Date(),
}: {
  production: ProductionState;
  plan: DemandPlan;
  handover: HandoverBreakdown;
  now?: Date;
}) {
  const { produced, target, remaining } = production;
  const expected = expectedByNow(target, now);
  const behind = Math.max(0, expected - produced);
  const onTrack = target === 0 || produced >= expected;
  const daysLeft = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate() - now.getUTCDate();
  const neededPerDay = daysLeft > 0 ? Math.ceil(remaining / daysLeft) : remaining;

  /*
    Joined on id, and the plan leads.

    The plan is the roster that can be given work — people with a quota — so it
    decides who has a row. Handover is looked up beside it and may be missing for
    somebody who has received nothing yet; that is a real state and renders as a
    zero, not as an absent row.
  */
  const byId = new Map((handover.rows ?? []).map((r) => [r.assigneeId, r]));
  const people = [...plan.people]
    .sort((a, b) => a.daysOfCover - b.daysOfCover || b.deficit - a.deficit)
    .map((p) => ({ ...p, handover: byId.get(p.id) }));

  const short = people.filter((p) => p.daysOfCover < 3);
  const urgentTotal = people.reduce((sum, p) => sum + p.urgentDeficit, 0);

  return (
    <Card>
      <CardHeader
        title="Supply & team"
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

      <CardBody className="space-y-4">
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

        <p className="text-muted text-[11px]">
          {short.length === 0
            ? 'Everyone has more than three days of work in stock.'
            : `${short.length} ${short.length === 1 ? 'person is' : 'people are'} below the three-day floor` +
              (urgentTotal > 0 ? ` · ${urgentTotal.toLocaleString()} more ready leads would cover everyone.` : '.')}
        </p>
      </CardBody>

      <Table>
        <THead>
          <tr>
            <Th>Person</Th>
            <Th align="right">In stock</Th>
            <Th align="right">Daily draw</Th>
            <Th align="right">Days cover</Th>
            <Th>Status</Th>
            <Th align="right">Received</Th>
            <Th align="right">Ready to send</Th>
            <Th align="right">Waiting on contact</Th>
            <Th align="right">Needs</Th>
          </tr>
        </THead>
        <TBody>
          {people.map((p) => {
            const band = coverBand(p.daysOfCover);
            const { Icon } = band;
            const h = p.handover;
            return (
              <tr key={p.id}>
                <Td>
                  <span className="text-foreground font-medium">{p.name}</span>
                  {/*
                    An inactive person can still hold leads, and those leads are
                    going nowhere — the export skips them. This is the only place
                    it surfaces.
                  */}
                  {h && !h.isActive ? (
                    <Badge tone="warning" className="ml-2">
                      inactive
                    </Badge>
                  ) : null}
                </Td>
                <Td align="right">{p.covered.toLocaleString()}</Td>
                <Td align="right">{p.dailyQuota.toLocaleString()}</Td>
                {/*
                  The figure carries the tone as well as the badge. It is the number
                  a manager scans down, and a column of neutral digits beside a
                  column of coloured badges makes them read the badge and look back.
                */}
                <Td align="right">
                  <span
                    className={cn(
                      'font-bold tabular-nums',
                      band.tone === 'neutral' ? 'text-foreground' : statusText[band.tone]
                    )}
                  >
                    {p.daysOfCover.toFixed(1)}
                  </span>
                </Td>
                <Td>
                  <span className="inline-flex items-center gap-1.5">
                    <Icon
                      size={13}
                      className={band.tone === 'neutral' ? 'text-muted' : statusText[band.tone]}
                      aria-hidden
                    />
                    <Badge tone={band.tone}>{band.label}</Badge>
                  </span>
                </Td>
                <Td align="right">{h ? h.received.toLocaleString() : '—'}</Td>
                <Td align="right">
                  {h && h.ready > 0 ? (
                    <span className={statusText.success}>{h.ready.toLocaleString()}</span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </Td>
                <Td align="right">
                  {h && h.waitingOnContact > 0 ? h.waitingOnContact.toLocaleString() : '—'}
                </Td>
                <Td align="right">
                  {p.urgentDeficit > 0 ? (
                    <span className={cn('font-semibold tabular-nums', statusText.warning)}>
                      {p.urgentDeficit.toLocaleString()}
                    </span>
                  ) : (
                    <span className="text-subtle text-[10px]">—</span>
                  )}
                </Td>
              </tr>
            );
          })}
        </TBody>
      </Table>

      {/*
        A count that could not be taken must not read as a covered team, and a
        handover table that could not be read must not read as nobody receiving
        anything. Both sources report their own failure and this is where they say so.
      */}
      {plan.inventoryUnavailable || handover.tableMissing ? (
        <p className={cn('border-border-base border-t px-5 py-3 text-[11px]', statusText.warning)}>
          {plan.inventoryUnavailable
            ? `Stock could not be read, so cover is incomplete — ${plan.inventoryUnavailable}`
            : 'Handover figures are unavailable, so the received and ready columns are blank rather than zero.'}
        </p>
      ) : null}

      <div className="border-border-base border-t px-5 py-3">
        <Link href="/control/team" className="text-brand text-[11px] underline underline-offset-2">
          Quotas and scopes on Team &amp; Users →
        </Link>
      </div>
    </Card>
  );
}
