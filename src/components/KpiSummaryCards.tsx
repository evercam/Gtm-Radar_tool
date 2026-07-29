import Link from 'next/link';
import type { KpiSummary } from '@/lib/kpi';
import { STATUS_COLORS, STATUS_LABELS, type LeadStatus } from '@/lib/lifecycle';
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
}) {
  const maxFunnel = Math.max(1, ...kpi.funnel.map((f) => f.count));
  // The dead ends carry no information in a compact view.
  const funnel = kpi.funnel.filter((f) => f.status !== 'LOST' || f.count > 0);

  return (
    <Card>
      <CardHeader
        title={scope === 'you' ? 'Your performance' : 'Team performance'}
        subtitle={`Last ${days} days · ${kpi.total.toLocaleString()} records`}
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
          <Stat
            label="Contact rate"
            value={`${kpi.conversion.contactRate}%`}
            note={`${kpi.conversion.contacted.toLocaleString()} of ${kpi.conversion.assigned.toLocaleString()} assigned`}
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
          {funnel.map((f) => (
            <div key={f.status} className="flex items-center gap-3">
              <span className="w-32 shrink-0">
                <Badge className={STATUS_COLORS[f.status as LeadStatus] ?? STATUS_COLORS_SAFE}>
                  {STATUS_LABELS[f.status as LeadStatus] ?? f.status}
                </Badge>
              </span>
              <ProgressBar value={f.count} max={maxFunnel} tone="neutral" className="flex-1" />
              <span className="text-muted w-16 shrink-0 text-right text-[11px] tabular-nums">
                {f.count.toLocaleString()}
              </span>
            </div>
          ))}
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
