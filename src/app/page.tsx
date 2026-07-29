import Link from 'next/link';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { getPipelineRollup, getTopPriorityLeads, getDispositionRollup, hasPriorityColumns } from '@/lib/queries';
import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { getKpiSummary } from '@/lib/kpi';
import KpiSummaryCards from '@/components/KpiSummaryCards';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import MigrationRequired from '@/components/MigrationRequired';
import PipelineRollup from '@/components/PipelineRollup';
import { BAND_COLORS, BAND_LABELS, TIER_COLORS, TIER_LABELS } from '@/lib/semantics';
import { Card, CardHeader, CardBody, Badge, EmptyState, ProgressBar } from '@/components/ui';

export const dynamic = 'force-dynamic';

const KPI_WINDOWS = [7, 30, 90];

const LANE_BAR: Record<string, string> = {
  'sales/act_now': 'bg-emerald-500',
  'sales/qualify': 'bg-emerald-400',
  'marketing/nurture': 'bg-amber-400',
  'partner/hold': 'bg-violet-400',
  'none/hold': 'bg-zinc-400',
  'none/disqualify': 'bg-zinc-300',
};
const LANE_TEXT: Record<string, string> = {
  sales: 'text-emerald-700 dark:text-emerald-300',
  marketing: 'text-amber-700 dark:text-amber-300',
  partner: 'text-violet-700 dark:text-violet-300',
  none: 'text-muted',
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; days?: string }>;
}) {
  const user = await requireUser('/');
  const { denied, days: daysParam } = await searchParams;
  const days = KPI_WINDOWS.includes(Number(daysParam)) ? Number(daysParam) : 30;

  // A seller sees their own numbers; only managers and admins see the team's.
  const seesTeam = can(user.role, 'kpi.view.team') || can(user.role, 'leads.view.all');

  if (!isSupabaseServerConfigured()) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-16">
        <SupabaseNotConfigured />
      </div>
    );
  }

  let rollup, topLeads, disposition, migrated, kpi;
  try {
    [rollup, topLeads, disposition, migrated, kpi] = await Promise.all([
      getPipelineRollup(),
      getTopPriorityLeads(8),
      getDispositionRollup(),
      hasPriorityColumns(),
      getKpiSummary({ days, ownerId: seesTeam ? undefined : user.id }),
    ]);
  } catch (err) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-16">
        <SupabaseNotConfigured detail={err instanceof Error ? err.message : String(err)} />
      </div>
    );
  }

  const { scored, routed, total: totalRecords, byBand, byLane, routedHoursAgo, routingMissing } = disposition;
  const { byTier, untiered } = disposition;
  const tiered = totalRecords - untiered;
  // A and B arrive workable; D and E need enrichment before anyone can call.
  const workable = byTier.filter((t) => t.tier === 'A' || t.tier === 'B').reduce((s, t) => s + t.count, 0);
  const canSearch = can(user.role, 'sources.run');
  const canRoute = can(user.role, 'routing.edit');

  const toSales = byLane.filter((l) => l.route === 'sales').reduce((sum, l) => sum + l.count, 0);
  const actNow = byLane.find((l) => l.route === 'sales' && l.stage === 'act_now')?.count ?? 0;
  const maxLane = Math.max(1, ...byLane.map((l) => l.count));
  const unrouted = totalRecords - routed;

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      {denied ? (
        <div className="border-warning/40 bg-warning/10 text-warning mb-6 rounded-[12px] border px-4 py-3 text-sm">
          That area needs a role you don&apos;t have. Ask an administrator if you need access.
        </div>
      ) : null}

      <div className="mb-8">
        <h1 className="text-foreground text-2xl font-bold">Dashboard</h1>
        <p className="text-muted mt-1 max-w-3xl text-sm">
          Every source — construction, procurement, permits, energy and news — normalized into one table, scored for
          priority and routed into a lane.
        </p>
      </div>

      {/* Performance — moved here from the Control Center so the people whose
          numbers these are can actually see them. */}
      {can(user.role, 'kpi.view') && !kpi.tableMissing ? (
        <div className="mb-10">
          <div className="mb-3 flex items-center justify-end gap-1.5">
            {KPI_WINDOWS.map((w) => (
              <Link
                key={w}
                href={`/?days=${w}`}
                className={`rounded-lg border px-2.5 py-1 text-[10px] font-semibold transition-colors ${
                  days === w
                    ? 'border-brand/40 bg-brand/10 text-brand'
                    : 'border-border-base bg-surface-raised text-muted hover:text-foreground'
                }`}
              >
                {w}d
              </Link>
            ))}
          </div>
          <KpiSummaryCards
            kpi={kpi}
            days={days}
            scope={seesTeam ? 'team' : 'you'}
            canExport={can(user.role, 'leads.export') || seesTeam}
          />
        </div>
      ) : null}

      {/* Priority — the work queue */}
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-foreground text-lg font-semibold">Top priority leads</h2>
        <div className="flex gap-3 text-sm">
          <Link href="/records?sort=priority" className="text-brand underline underline-offset-2">
            All records
          </Link>
          {can(user.role, 'enrichment.run') ? (
            <Link href="/control/enrichment" className="text-brand underline underline-offset-2">
              Enrichment queue
            </Link>
          ) : null}
        </div>
      </div>

      <div className="mb-10">
        {!migrated ? (
          <MigrationRequired feature="Lead priority scoring" />
        ) : scored === 0 ? (
          <EmptyState
            title="Nothing scored yet"
            description="Records are ingested but not yet ranked."
            action={
              can(user.role, 'routing.edit') ? (
                <Link href="/control/routing" className="text-brand text-sm underline">
                  Score &amp; route all
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {byBand.map((b) => (
                <Link key={b.band} href={`/records?band=${b.band}`} prefetch={false}>
                  <Card interactive className="p-4">
                    <Badge className={BAND_COLORS[b.band]}>{b.band}</Badge>
                    <p className="text-foreground mt-1.5 text-lg font-semibold tabular-nums">
                      {b.count.toLocaleString()}
                    </p>
                    <p className="text-muted text-[11px]">{BAND_LABELS[b.band]}</p>
                    <ProgressBar value={b.count} max={Math.max(1, scored)} tone="neutral" className="mt-2" />
                  </Card>
                </Link>
              ))}
            </div>

            {topLeads.length > 0 ? (
              <Card className="overflow-hidden">
                <ul className="divide-border-base divide-y">
                  {topLeads.map((lead) => (
                    <li key={lead.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <Badge className={BAND_COLORS[lead.priority_band ?? 'P4']}>
                        {lead.priority_band} · {lead.priority_score}
                      </Badge>
                      <span className="text-foreground min-w-0 flex-1 truncate font-medium">
                        {lead.account_key ? (
                          <Link
                            href={`/accounts/${encodeURIComponent(lead.account_key)}`}
                            prefetch={false}
                            className="hover:underline"
                          >
                            {lead.canonical_name}
                          </Link>
                        ) : (
                          lead.canonical_name
                        )}
                      </span>
                      <span className="text-muted hidden shrink-0 text-xs sm:block">
                        {lead.priority_reasons?.slice(0, 2).join(' · ')}
                      </span>
                      <span className="text-subtle shrink-0 text-xs">{lead.source_key}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </>
        )}
      </div>

      {/* Where the work landed — the materialized lanes, not a dry-run. */}
      {!routingMissing && routed > 0 ? (
        <>
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-foreground text-lg font-semibold">Where the work landed</h2>
            <div className="flex items-center gap-3 text-sm">
              {routedHoursAgo !== null ? (
                <span className="text-subtle text-xs">
                  routed{' '}
                  {routedHoursAgo < 1
                    ? 'just now'
                    : routedHoursAgo < 24
                      ? `${routedHoursAgo}h ago`
                      : `${Math.round(routedHoursAgo / 24)}d ago`}
                </span>
              ) : null}
              {canRoute ? (
                <Link href="/control/routing" className="text-brand underline underline-offset-2">
                  Rules
                </Link>
              ) : null}
            </div>
          </div>

          <div className="mb-10 grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="grid grid-cols-1 gap-3">
              <Link href="/records?route=sales&stage=act_now" prefetch={false}>
                <Card interactive className="p-4">
                  <p className="text-muted text-[10px] font-bold uppercase tracking-widest">Act now</p>
                  <p className="text-success mt-1.5 text-xl font-bold tabular-nums">{actNow.toLocaleString()}</p>
                  <p className="text-subtle mt-0.5 text-[10px]">sales, contacted first</p>
                </Card>
              </Link>
              <Link href="/records?route=sales" prefetch={false}>
                <Card interactive className="p-4">
                  <p className="text-muted text-[10px] font-bold uppercase tracking-widest">Owned by sales</p>
                  <p className="text-foreground mt-1.5 text-xl font-bold tabular-nums">{toSales.toLocaleString()}</p>
                  <p className="text-subtle mt-0.5 text-[10px]">
                    {Math.round((toSales / (routed || 1)) * 100)}% of routed records
                  </p>
                </Card>
              </Link>
            </div>

            <Card className="lg:col-span-2">
              <CardHeader
                title="Lanes"
                subtitle={
                  unrouted > 0
                    ? `${unrouted.toLocaleString()} record${unrouted === 1 ? '' : 's'} not yet routed`
                    : 'every record has a lane'
                }
              />
              <div className="space-y-2.5 px-5 py-4">
                {byLane.map((l) => (
                  <Link
                    key={`${l.route}/${l.stage}`}
                    href={`/records?route=${l.route}&stage=${l.stage}`}
                    prefetch={false}
                    className="group flex items-center gap-3"
                  >
                    <div className="w-36 shrink-0 text-[11px]">
                      <span className={`font-bold ${LANE_TEXT[l.route] ?? 'text-muted'} group-hover:underline`}>
                        {l.route}
                      </span>
                      <span className="text-subtle"> / {l.stage}</span>
                    </div>
                    <div className="bg-surface-raised h-4 flex-1 overflow-hidden rounded">
                      <div
                        className={`h-full ${LANE_BAR[`${l.route}/${l.stage}`] ?? 'bg-zinc-400'}`}
                        style={{ width: `${Math.max(2, (l.count / maxLane) * 100)}%` }}
                      />
                    </div>
                    <div className="text-foreground w-24 shrink-0 text-right text-[11px] font-bold tabular-nums">
                      {l.count.toLocaleString()}
                      <span className="text-subtle ml-1 font-normal">
                        {Math.round((l.count / (routed || 1)) * 100)}%
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </Card>
          </div>
        </>
      ) : !routingMissing && scored > 0 && canRoute ? (
        <div className="mb-10">
          <EmptyState
            title="Scored, but not routed"
            description="Records have priority bands but no lane yet, so nobody owns them."
            action={
              <Link href="/control/routing" className="text-brand text-sm underline">
                Route them
              </Link>
            }
          />
        </div>
      ) : null}

      {/* Pipeline */}
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-foreground text-lg font-semibold">Pipeline</h2>
        {canSearch ? (
          <Link href="/control/sources" className="text-brand text-sm underline underline-offset-2">
            the Source Hub
          </Link>
        ) : null}
      </div>
      <div className="mb-10">
        <PipelineRollup rows={rollup} />
      </div>

      {/* Completeness reference */}
      <Card>
        <CardHeader
          title="Data completeness"
          subtitle="How much each source gives us before enrichment"
          action={
            <span className="text-subtle text-[11px] tabular-nums">
              {Math.round((workable / (tiered || 1)) * 100)}% arrive workable
            </span>
          }
        />
        <CardBody>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {byTier.map((t) => {
              const pct = (t.count / (tiered || 1)) * 100;
              return (
                <Link key={t.tier} href={`/records?tier=${t.tier}`} prefetch={false} className="group">
                  <Badge className={TIER_COLORS[t.tier]}>Tier {t.tier}</Badge>
                  <p className="text-foreground mt-2 text-lg font-bold tabular-nums">
                    {t.count.toLocaleString()}
                    <span className="text-subtle ml-1.5 text-[11px] font-normal">
                      {pct < 1 && t.count > 0 ? '<1' : Math.round(pct)}%
                    </span>
                  </p>
                  <p className="text-muted text-[11px] group-hover:underline">{TIER_LABELS[t.tier]}</p>
                  <ProgressBar
                    value={t.count}
                    max={Math.max(1, ...byTier.map((x) => x.count))}
                    tone="neutral"
                    className="mt-2"
                  />
                </Link>
              );
            })}
          </div>
          {untiered > 0 ? (
            <p className="text-subtle mt-4 text-[11px]">
              {untiered.toLocaleString()} record{untiered === 1 ? '' : 's'} arrived without a tier.
            </p>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
