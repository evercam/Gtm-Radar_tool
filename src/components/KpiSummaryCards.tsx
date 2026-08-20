import Link from 'next/link';
import JourneyCards from '@/components/JourneyCards';
import type { KpiSummary } from '@/lib/kpi';
import {
  JOURNEY_STAGE_COLORS,
  JOURNEY_STAGE_LABELS,
  type JourneyStage,
} from '@/lib/lifecycle';
import { STATUS_COLORS_SAFE } from '@/lib/semantics';
import { Card, CardHeader, CardBody, Stat } from '@/components/ui';

/**
 * Performance, on the Dashboard.
 *
 * This used to be a Control Center tab, which meant sellers — the people whose
 * numbers these are — could not see them at all. It belongs where everyone
 * already starts their day.
 *
 * `scope` says whose figures these are, so "12% conversion" is never ambiguous
 * about whether it means you or the company.
 */

/**
 * How old the figures are, in the shortest form that is still unambiguous.
 *
 * A clock time for today ("as of 14:20") because that is how somebody thinks about
 * this morning's numbers, and a date once it is older, because "as of 14:20" on a
 * two-day-old snapshot would read as today and be actively misleading — which is the
 * one outcome this label exists to prevent.
 */
function asOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';
  const today = new Date().toDateString() === at.toDateString();
  return today
    ? at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
export default function KpiSummaryCards({
  kpi,
  days,
  scope,
  canExport,
}: {
  kpi: KpiSummary;
  days: number;
  scope: 'you' | 'team';
  canExport: boolean;
  /**
   * Whether to offer the export-history link. Deliberately separate from
   * `canExport`, which is widened by team visibility — /control/exports gates on
   * leads.export alone.
   */
}) {
  // Every stage is measured against the top of the funnel, so the bars shrink
  // down the path instead of each being scaled to whichever stage is busiest.
  const funnel = kpi.funnel.filter((f) => f.status !== 'LOST');
  const entered = Math.max(1, funnel[0]?.reached ?? 0);
  const lost = kpi.funnel.find((f) => f.status === 'LOST');

  return (
    <Card>
      <CardHeader
        /*
          Named for what it shows.

          It was "Team performance", which described a card of four rate metrics.
          Three of those are gone and the body is now the journey — where leads are
          and where they stop. A title that no longer matches its contents is worse
          than a dull one: it tells the reader to expect something the card cannot
          give them.
        */
        title={scope === 'you' ? 'Your lead journey' : 'Lead journey'}
        /*
          The age of the figures is part of the subtitle, not a footnote.

          The team summary is served from a snapshot refreshed by the cron, because
          building it live reads the whole 109,552-row book and took 35-46 seconds.
          That trade is only honest if the card says so — numbers presented as live
          when they are hours old are a worse bug than the slowness they replaced.

          Absent for a seller's own figures, which are still computed per request.
        */
        subtitle={`Last ${days} days · ${kpi.total.toLocaleString()} records${
          kpi.computedAt ? ` · as of ${asOf(kpi.computedAt)}` : ''
        }`}
        action={
          canExport ? (
            <a href={`/api/kpi/export?days=${days}`} className="text-brand text-[11px] underline">
              Export CSV
            </a>
          ) : null
        }
      />
      <CardBody className="space-y-5">
        {/*
          One rate, not four.

          Handover rate, Past SLA and Time to contact left this card. Nothing was
          lost with the first: the journey below shows Assigned 624 -> Exported 400
          at a 36% fall, which IS the handover rate — it was the same fact stated
          twice, once as a ratio and once as a step. The other two had no data to
          report and said so honestly, which is correct behaviour and still a whole
          tile spent saying "not measured yet".

          Enrichment stays because it is the one rate the journey cannot show: the
          funnel counts leads that reached a stage, and this counts how often the
          attempt succeeded. A stage can be small because few entered it or because
          most attempts failed, and only this tells those apart.
        */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Enrichment"
            value={`${kpi.enrichment.successRate}%`}
            note={`${kpi.enrichment.succeeded.toLocaleString()} of ${kpi.enrichment.attempted.toLocaleString()} attempts`}
          />
        </div>

        <JourneyCards
          entered={entered}
          steps={funnel.map((f) => ({
            status: f.status,
            label: JOURNEY_STAGE_LABELS[f.status as JourneyStage] ?? f.status,
            badgeClass: JOURNEY_STAGE_COLORS[f.status as JourneyStage] ?? STATUS_COLORS_SAFE,
            reached: f.reached,
            here: f.count,
          }))}
        />

        {/*
          Off the path, so it is a line rather than a card. Giving LOST a tile in
          the row would put it in the sequence, and it is not a stage anything
          passes through — it is where records go when they stop.
        */}
        {lost && lost.count > 0 ? (
          <p className="text-subtle text-[10px]">
            {lost.count.toLocaleString()} left the funnel ({JOURNEY_STAGE_LABELS.LOST.toLowerCase()}).
          </p>
        ) : null}

        {scope === 'team' && kpi.byOwner.length > 0 ? (
          <p className="text-subtle text-[10px]">
            Per-owner and per-source breakdowns are on{' '}
            <Link href="/control/team" className="text-brand underline">
              Team
            </Link>
            .
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
