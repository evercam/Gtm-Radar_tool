import Link from 'next/link';
import type { KpiSummary } from '@/lib/kpi';
import {
  JOURNEY_STAGE_COLORS,
  JOURNEY_STAGE_LABELS,
  type JourneyStage,
} from '@/lib/lifecycle';
import { STATUS_COLORS_SAFE } from '@/lib/semantics';
import { Card, CardHeader, CardBody, Badge, Stat, ProgressBar } from '@/components/ui';

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
  canSeeExportHistory,
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
  canSeeExportHistory: boolean;
}) {
  // Every stage is measured against the top of the funnel, so the bars shrink
  // down the path instead of each being scaled to whichever stage is busiest.
  const funnel = kpi.funnel.filter((f) => f.status !== 'LOST');
  const entered = Math.max(1, funnel[0]?.reached ?? 0);
  const lost = kpi.funnel.find((f) => f.status === 'LOST');

  const handoverRate =
    kpi.conversion.assigned > 0
      ? Math.round((kpi.export.exported / kpi.conversion.assigned) * 1000) / 10
      : 0;

  return (
    <Card>
      <CardHeader
        title={scope === 'you' ? 'Your performance' : 'Team performance'}
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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Enrichment"
            value={`${kpi.enrichment.successRate}%`}
            note={`${kpi.enrichment.succeeded.toLocaleString()} of ${kpi.enrichment.attempted.toLocaleString()}`}
          />
          {/*
            Handover, not contact. The call happens in Apollo, so a contact rate
            measured from this database reads 0% no matter how much outreach the
            team does. What this tool can honestly claim is how much of the
            assigned work it actually got shipped.
          */}
          <Stat
            label="Handover rate"
            value={`${handoverRate}%`}
            note={
              <>
                {kpi.export.exported.toLocaleString()} of {kpi.conversion.assigned.toLocaleString()} assigned sent
                {/*
                  The number is one click from the runs that produced it. Apollo
                  raises no notification when contacts are created, so "did the
                  handover actually happen, and when" has exactly one answer in
                  this app and it was reachable only from a tab inside
                  Operations.

                  Gated on its own permission rather than `canExport`, which is
                  widened by `seesTeam` — a manager without leads.export would
                  have been offered a link that redirects them to sign-in.
                */}
                {canSeeExportHistory ? (
                  <>
                    {' · '}
                    <Link href="/control/exports" className="text-brand underline">
                      history
                    </Link>
                  </>
                ) : null}
              </>
            }
          />
          <Stat
            label="Past SLA"
            value={kpi.sla.breached.toLocaleString()}
            note={`${kpi.sla.breachRate}% of ${kpi.sla.tracked.toLocaleString()} tracked`}
            tone={kpi.sla.breachRate > 20 ? 'danger' : kpi.sla.breachRate > 5 ? 'warning' : undefined}
          />
          <Stat
            label="Time to contact"
            value={kpi.sla.medianHoursToContact !== null ? `${kpi.sla.medianHoursToContact}h` : '—'}
            note="median, from assignment"
          />
        </div>

        <div className="space-y-1.5">
          <div className="text-subtle flex items-baseline justify-between text-[10px] uppercase tracking-wide">
            <span>Lead journey</span>
            <span className="normal-case">reached · here now</span>
          </div>

          {funnel.map((f) => (
            <div key={f.status} className="flex items-center gap-3">
              <span className="w-32 shrink-0">
                <Badge className={JOURNEY_STAGE_COLORS[f.status as JourneyStage] ?? STATUS_COLORS_SAFE}>
                  {JOURNEY_STAGE_LABELS[f.status as JourneyStage] ?? f.status}
                </Badge>
              </span>
              <ProgressBar value={f.reached} max={entered} tone="neutral" className="flex-1" />
              <span className="w-24 shrink-0 text-right text-[11px] tabular-nums">
                <span className="text-foreground">{f.reached.toLocaleString()}</span>
                {/* Occupancy is the actionable half: what is sitting here now. */}
                <span className="text-subtle"> · {f.count.toLocaleString()}</span>
              </span>
            </div>
          ))}

          {lost && lost.count > 0 ? (
            <div className="flex items-center gap-3 pt-1">
              <span className="w-32 shrink-0">
                <Badge className={JOURNEY_STAGE_COLORS.LOST}>{JOURNEY_STAGE_LABELS.LOST}</Badge>
              </span>
              {/* Off the path, so it gets no bar to compare against the stages. */}
              <span className="text-subtle flex-1 text-[10px]">left the funnel</span>
              <span className="w-24 shrink-0 text-right text-[11px] tabular-nums">
                <span className="text-muted">{lost.count.toLocaleString()}</span>
              </span>
            </div>
          ) : null}
        </div>

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
