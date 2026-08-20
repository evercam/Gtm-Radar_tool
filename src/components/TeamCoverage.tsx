import { AlertTriangle, ArrowDown, ArrowUp, Minus } from 'lucide-react';
import type { DemandPlan } from '@/lib/enrich/demand';
import { Badge, Card, CardBody, CardHeader, Table, TBody, THead, Th, Td } from '@/components/ui';
import { cn } from '@/lib/cn';
import { statusText } from '@/lib/status-colors';

/**
 * Who runs out of work first.
 *
 * The supply panel already said "3 people are below 3 days, the thinnest being
 * Jose Sanchez at 0.1" — one sentence, naming one person, with the other two
 * unnamed and no way to compare any of them. A manager reading that cannot answer
 * the next question, which is always "and who else, and by how much".
 *
 * So it is a table, sorted thinnest-first, because the row that matters is the top
 * one and sorting by name would bury it. Days of cover is the column to read:
 * "13 leads" means nothing without knowing they burn 10 a day.
 *
 * STATUS IS A TONE PLUS AN ICON PLUS A WORD — NEVER A COLOUR ALONE
 *
 * The spec this came from used 🔴🟠🟡🟢. Same semantics, wrong mechanism: emoji
 * cannot follow the theme, render differently on every OS, and are read out
 * literally by a screen reader. Badge tones are contrast-validated in both modes
 * and the Lucide icon carries the same rank for anyone who cannot separate the
 * hues — which is the rule the lane palette work landed on too.
 */

/**
 * Where the thresholds come from.
 *
 * Under a day means they idle today, which is the only genuinely urgent state.
 * Three days is the operational floor the demand plan itself defends — see
 * PersonDemand.floor, which is three days of their own draw. A week is comfortable.
 * These are the plan's own numbers, not new policy invented for a colour.
 */
const COVER_BANDS = [
  { max: 1, tone: 'danger', label: 'idle today', Icon: AlertTriangle },
  { max: 3, tone: 'warning', label: 'below floor', Icon: ArrowDown },
  { max: 7, tone: 'neutral', label: 'thin', Icon: Minus },
  { max: Infinity, tone: 'success', label: 'on track', Icon: ArrowUp },
] as const;

function coverBand(days: number) {
  return COVER_BANDS.find((b) => days < b.max) ?? COVER_BANDS[COVER_BANDS.length - 1];
}

export default function TeamCoverage({ plan }: { plan: DemandPlan }) {
  // Thinnest first. Ties broken by the larger deficit, so of two people at the
  // same runway the one who needs more to fix it is listed first.
  const people = [...plan.people].sort((a, b) => a.daysOfCover - b.daysOfCover || b.deficit - a.deficit);
  if (people.length === 0) return null;

  const short = people.filter((p) => p.daysOfCover < 3);
  const urgentTotal = people.reduce((sum, p) => sum + p.urgentDeficit, 0);

  return (
    <Card>
      <CardHeader
        title="Team coverage"
        subtitle={
          short.length === 0
            ? 'everyone has more than three days of work in stock'
            : `${short.length} ${short.length === 1 ? 'person is' : 'people are'} below the three-day floor`
        }
        action={
          urgentTotal > 0 ? (
            <Badge tone="warning">{urgentTotal.toLocaleString()} leads short</Badge>
          ) : (
            <Badge tone="success">covered</Badge>
          )
        }
      />
      <CardBody className="px-0 py-0">
        <Table>
          <THead>
            <tr>
              <Th>Person</Th>
              <Th align="right">In stock</Th>
              <Th align="right">Daily draw</Th>
              <Th align="right">Days of cover</Th>
              <Th>Status</Th>
              <Th align="right">Needs</Th>
            </tr>
          </THead>
          <TBody>
            {people.map((p) => {
              const band = coverBand(p.daysOfCover);
              const { Icon } = band;
              return (
                <tr key={p.id}>
                  <Td>
                    <span className="text-foreground font-medium">{p.name}</span>
                  </Td>
                  <Td align="right">{p.covered.toLocaleString()}</Td>
                  <Td align="right">{p.dailyQuota.toLocaleString()}</Td>
                  {/*
                    The figure carries the tone as well as the badge. It is the
                    number a manager scans down, and a column of neutral digits
                    beside a column of coloured badges makes them read the badge
                    and then look back — twice the work for the same fact.
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
                      <Icon size={13} className={band.tone === 'neutral' ? 'text-muted' : statusText[band.tone]} aria-hidden />
                      <Badge tone={band.tone}>{band.label}</Badge>
                    </span>
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
          A count that could not be measured must not read as a covered team. The
          demand plan reports its own failed inventory read rather than returning
          an empty one, and this is the only place that says so.
        */}
        {plan.inventoryUnavailable ? (
          <p className={cn('border-border-base border-t px-5 py-3 text-[11px]', statusText.warning)}>
            Stock could not be read, so these figures are incomplete — {plan.inventoryUnavailable}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
