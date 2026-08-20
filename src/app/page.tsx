import Link from 'next/link';
import { statusText } from '@/lib/status-colors';
import { cn } from '@/lib/cn';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { getHandoverByPerson, getPipelineRollup, getBuRollup, getTopPriorityLeads, getDispositionRollup, hasPriorityColumns, getProductionState } from '@/lib/queries';
import { getDemandPlan } from '@/lib/enrich/demand';
import { getEnrichmentPolicy } from '@/lib/policies';
import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { Suspense } from 'react';
import { getKpiSummary } from '@/lib/kpi';
import KpiSummaryCards from '@/components/KpiSummaryCards';
import HandoverByPerson from '@/components/HandoverByPerson';
import SupplyStatus from '@/components/SupplyStatus';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import MigrationRequired from '@/components/MigrationRequired';
import PipelineRollup from '@/components/PipelineRollup';
import BuStats from '@/components/BuStats';
import RecordLink from '@/components/RecordLink';
import { BAND_COLORS, BAND_LABELS, TIER_COLORS, TIER_LABELS } from '@/lib/semantics';
import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Chip,
  EmptyState,
  MetricTile,
  ProgressBar,
  SectionHeading,
  Skeleton,
  SkeletonTiles,
} from '@/components/ui';
import LaneChart from '@/components/LaneChart';

export const dynamic = 'force-dynamic';

const KPI_WINDOWS = [7, 30, 90];



/**
 * The fallback every streamed panel shares.
 *
 * Roughly panel-shaped rather than an exact copy of any one of them: a fallback
 * that matched a specific table would be wrong for the others, and the point is
 * that the page stops being blank, not that it lies convincingly.
 */
function PanelSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Card>
      <CardBody>
        <Skeleton className="h-4 w-44" />
        <div className="mt-4 space-y-2.5">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-3 w-32 shrink-0" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 w-12 shrink-0" />
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Performance figures. Awaits its own data so the page does not.
 *
 * `tableMissing` is handled here rather than by the caller: deciding whether to
 * render this at all used to require the data, which is exactly the dependency
 * that made it blocking.
 */
async function KpiSection({
  days,
  seesTeam,
  permissions,
  userId,
}: {
  days: number;
  seesTeam: boolean;
  /* The resolved bundle, not a role name — roles are database rows now. */
  permissions: string[];
  userId: string;
}) {
  const kpi = await getKpiSummary({ days, ownerId: seesTeam ? undefined : userId });
  if (kpi.tableMissing) return null;
  return (
    <KpiSummaryCards
      kpi={kpi}
      days={days}
      scope={seesTeam ? 'team' : 'you'}
      canExport={can({ permissions }, 'leads.export') || seesTeam}
      canSeeExportHistory={can({ permissions }, 'leads.export')}
    />
  );
}

/**
 * Who received what.
 *
 * No try/catch: `getHandoverByPerson` already reports its own failures as
 * `tableMissing` rather than throwing, so catching here caught nothing and
 * tripped react-hooks/error-boundaries for the privilege.
 */
async function HandoverSection() {
  return <HandoverByPerson breakdown={await getHandoverByPerson()} />;
}

/**
 * Stock per business unit, and the BU x vertical grid.
 *
 * THESE TWO ARE WHY THE DASHBOARD STOPPED RENDERING. Both walk the whole
 * canonical_projects table, and measured against 109,552 rows they take 73.7 s
 * and 74.6 s. They sat in the blocking `Promise.all` below, which waits for the
 * slowest — so the page could not paint for over a minute and read as permanently
 * loading, while the four panels above them were ready in under two seconds.
 *
 * Moving them behind a boundary is the same decision this file already made for
 * KpiSection, for the same reason, and it is worth being clear that it is not a
 * performance fix: the queries are still slow, and 20260818160000_dashboard_rollup
 * is what makes them fast. This is the structural half — after it, no single slow
 * read can blank the whole dashboard again, which is the property that survives the
 * next slow query somebody adds.
 *
 * They are also the last two panels on the page, so streaming them costs nothing
 * visually: nobody is looking at the bottom of the dashboard in the first second.
 *
 * No try/catch, like HandoverSection: getBuRollup returns `truncated: true` on
 * failure and getPipelineRollup returns an empty array. Neither throws, so a catch
 * here would catch nothing.
 */
async function BuSection() {
  const buRollup = await getBuRollup();
  return <BuStats rows={buRollup.rows} truncated={buRollup.truncated} />;
}

async function PipelineSection() {
  return <PipelineRollup rows={await getPipelineRollup()} />;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; days?: string }>;
}) {
  const user = await requireUser('/');
  const { denied, days: daysParam } = await searchParams;
  const days = KPI_WINDOWS.includes(Number(daysParam)) ? Number(daysParam) : 30;

  // A seller sees their own numbers; only managers and admins see the team's.
  const seesTeam = can(user, 'kpi.view.team') || can(user, 'leads.view.all');

  if (!isSupabaseServerConfigured()) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-16">
        <SupabaseNotConfigured />
      </div>
    );
  }

  /*
    What the page shell genuinely cannot render without. Measured: 0.4 s, 1.1 s and
    0.7 s — so this resolves in about a second.

    getPipelineRollup and getBuRollup used to be the first two entries here, at
    73.7 s and 74.6 s, and a Promise.all waits for the slowest. They now stream
    behind their own boundaries further down; see BuSection and PipelineSection.
  */
  let topLeads, disposition, migrated;
  try {
    // Positional destructuring: the names and the promises must stay in step, or
    // every value after an insertion is silently the wrong one.
    [topLeads, disposition, migrated] = await Promise.all([
      getTopPriorityLeads(8),
      getDispositionRollup(),
      hasPriorityColumns(),
    ]);
  } catch (err) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-16">
        <SupabaseNotConfigured detail={err instanceof Error ? err.message : String(err)} />
      </div>
    );
  }

  /**
   * Supply, loaded separately and allowed to fail.
   *
   * It reads the roster and a month of enrichment history, neither of which the
   * rest of the dashboard needs. A panel that cannot load should leave the page
   * standing rather than take it down — the numbers above are still true.
   */
  /**
   * Who received what, loaded separately and allowed to fail for the same reason
   * as supply below: it pages the whole assigned book and the rest of the page
   * does not need it.
   */
  let supply: { production: Awaited<ReturnType<typeof getProductionState>>; plan: Awaited<ReturnType<typeof getDemandPlan>> } | null = null;
  if (seesTeam) {
    try {
      const { config } = await getEnrichmentPolicy();
      const [production, plan] = await Promise.all([
        getProductionState(config.monthlyReadyTarget),
        getDemandPlan(config.monthlyReadyTarget),
      ]);
      supply = { production, plan };
    } catch (err) {
      console.warn(`Supply panel unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const { scored, routed, total: totalRecords, byBand, byLane, routedHoursAgo, routingMissing } = disposition;
  const { byTier, untiered, partial: countsPartial, failedCounts } = disposition;
  const tiered = totalRecords - untiered;
  // A and B arrive workable; D and E need enrichment before anyone can call.
  const workable = byTier.filter((t) => t.tier === 'A' || t.tier === 'B').reduce((s, t) => s + t.count, 0);
  const canSearch = can(user, 'sources.run');
  const canRoute = can(user, 'routing.edit');

  const actNow = byLane.find((l) => l.route === 'sales' && l.stage === 'act_now')?.count ?? 0;
  const unrouted = totalRecords - routed;

  /*
    THE GRID BUDGET — 12 columns, and tile size IS the hierarchy.

      row 1   four operational tiles                    3 + 3 + 3 + 3
      row 2   performance, streamed                     12
      row 3   top priority leads · lanes                8 + 4
      row 4   lead supply · handover        (manager)   6 + 6
      row 5   business units · completeness             7 + 5
      row 6   BU x vertical                             12

    Everything above `lg:` stacks to 12, so narrow screens are the old single
    column and nothing needs a second layout.

    Row 4 is the whole of the role difference. Both of its panels are already
    gated on `seesTeam` — supply is not even fetched without it — so for a seller
    the row is absent rather than half-empty. No span has to be recomputed per
    role, which is the only version of "role-aware layout" that cannot drift out
    of step with the permissions.
  */
  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      {denied ? (
        <Callout className="mb-6">
          That area needs a role you don&apos;t have. Ask an administrator if you need access.
        </Callout>
      ) : null}

      {/*
        Title and time range on one line.

        The range control used to sit ~250 lines down, right-aligned above the
        performance card alone, which made it read as that card's local filter
        rather than the page's. It is the same control either way; up here it is
        findable, and it is beside the only heading that is always on screen.

        The three-line paragraph that used to sit here described what the tool IS.
        That belongs on /help, which the rail links to — this space is the most
        valuable on the page and it now carries numbers.
      */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-foreground text-xl font-bold">Dashboard</h1>
        {can(user, 'kpi.view') ? (
          <div className="flex items-center gap-1.5">
            {KPI_WINDOWS.map((w) => (
              <Chip key={w} href={`/?days=${w}`} active={days === w}>
                {w}d
              </Chip>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/*
          ROW 1 — the five-second row.

          Every figure here comes out of `disposition`, which the shell already
          awaited, so the strip paints with the page and cannot be the thing that
          delays it. That is deliberate: the numbers a reader needs first must not
          depend on the slowest query on the page.

          Act now leads because it is the only one that names an action. Then what
          could be worked at all, then how much of the book has been scored and
          routed — the two that explain a thin queue.
        */}
        <MetricTile
          className="col-span-6 lg:col-span-3"
          href="/records?route=sales&stage=act_now"
          label="Act now"
          value={actNow.toLocaleString()}
          note="sales, contact first"
          tone="success"
        />
        <MetricTile
          className="col-span-6 lg:col-span-3"
          href="/records?tier=A"
          label="Workable"
          value={workable.toLocaleString()}
          note={`${Math.round((workable / (tiered || 1)) * 100)}% arrive callable`}
        />
        <MetricTile
          className="col-span-6 lg:col-span-3"
          href="/records?sort=priority"
          label="Scored"
          value={scored.toLocaleString()}
          note={`of ${totalRecords.toLocaleString()} records`}
        />
        <MetricTile
          className="col-span-6 lg:col-span-3"
          href={canRoute ? '/control/routing' : '/records'}
          label="Routed"
          value={routed.toLocaleString()}
          note={unrouted > 0 ? `${unrouted.toLocaleString()} still unrouted` : 'every record has a lane'}
          tone={unrouted > 0 ? 'warning' : undefined}
        />

        {/*
          ROW 2 — performance, still behind its own boundary.

          getKpiSummary pages the whole window (18.8 s measured) and this page used
          to block on it. The fallback is tile-shaped now rather than table-shaped,
          so the card does not change shape when the numbers land.
        */}
        {can(user, 'kpi.view') ? (
          <div className="col-span-12">
            <Suspense
              fallback={
                <Card>
                  <CardHeader title="Performance" subtitle="loading" />
                  <CardBody>
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      <SkeletonTiles count={4} />
                    </div>
                  </CardBody>
                </Card>
              }
            >
              <KpiSection days={days} seesTeam={seesTeam} permissions={user.permissions} userId={user.id} />
            </Suspense>
          </div>
        ) : null}

        {/* ROW 3 — the queue, and where the routed work went. */}
        <div className="col-span-12 lg:col-span-8">
          <SectionHeading
            className="mb-3"
            title="Top priority leads"
            actions={
              <>
                <Link href="/records?sort=priority" className="text-brand underline underline-offset-2">
                  All records
                </Link>
                {can(user, 'enrichment.run') ? (
                  <Link href="/control/enrichment" className="text-brand underline underline-offset-2">
                    Enrichment queue
                  </Link>
                ) : null}
              </>
            }
          />

          {!migrated ? (
            <MigrationRequired feature="Lead priority scoring" />
          ) : scored === 0 ? (
            <EmptyState
              title="Nothing scored yet"
              description="Records are ingested but not yet ranked."
              action={
                canRoute ? (
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
                          <RecordLink id={lead.id}>{lead.canonical_name}</RecordLink>
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

        <div className="col-span-12 lg:col-span-4">
          <SectionHeading
            className="mb-3"
            title="Where the work landed"
            actions={
              <>
                {routedHoursAgo !== null ? (
                  <span className="text-subtle text-xs">
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
              </>
            }
          />

          {!routingMissing && routed > 0 ? (
            <Card>
              <CardHeader
                title="Lanes"
                subtitle={
                  unrouted > 0
                    ? `${unrouted.toLocaleString()} record${unrouted === 1 ? '' : 's'} not yet routed`
                    : 'every record has a lane'
                }
              />
              <LaneChart rows={byLane} total={routed} className="px-5 py-4" />
            </Card>
          ) : !routingMissing && scored > 0 && canRoute ? (
            <EmptyState
              title="Scored, but not routed"
              description="Records have priority bands but no lane yet, so nobody owns them."
              action={
                <Link href="/control/routing" className="text-brand text-sm underline">
                  Route them
                </Link>
              }
            />
          ) : null}
        </div>

        {/*
          ROW 4 — manager only, in full.

          Both panels answer "is there enough work and did it reach anybody", which
          is why they are side by side: reading either one alone invites the wrong
          conclusion. A thin queue with supply on track is a distribution problem;
          the same queue with supply behind is a sourcing one.
        */}
        {supply ? (
          <div className="col-span-12 lg:col-span-6">
            <SupplyStatus production={supply.production} plan={supply.plan} />
          </div>
        ) : null}

        {seesTeam ? (
          <div className="col-span-12 lg:col-span-6">
            <Suspense fallback={<PanelSkeleton rows={5} />}>
              <HandoverSection />
            </Suspense>
          </div>
        ) : null}

        {/* ROW 5 — stock, and how complete it arrives. */}
        <div className="col-span-12">
          <SectionHeading
            className="mb-3"
            title="Pipeline"
            actions={
              canSearch ? (
                <Link href="/control/sources" className="text-brand underline underline-offset-2">
                  the Source Hub
                </Link>
              ) : null
            }
          />
        </div>

        <div className="col-span-12 lg:col-span-7">
          <Card>
            <CardHeader title="By business unit" subtitle="Where the stock is, and whether anyone's scope covers it" />
            <CardBody>
              <Suspense fallback={<PanelSkeleton rows={5} />}>
                <BuSection />
              </Suspense>
            </CardBody>
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-5">
          <Card>
            <CardHeader
              title="Data completeness"
              subtitle="How much each source gives us before enrichment"
              action={
                <span className="text-subtle text-[11px] tabular-nums">
                  {Math.round((workable / (tiered || 1)) * 100)}% workable
                </span>
              }
            />
            <CardBody>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              {/*
                A failed count used to render as a real zero, so this whole card read
                "0 across every tier" while the data was fine. Say so instead of
                showing a number that was never measured.
              */}
              {countsPartial ? (
                <p className={cn('mt-4 text-[11px]', statusText.warning)}>
                  {failedCounts} of these counts timed out, so the figures above are incomplete — reload to retry.
                </p>
              ) : untiered > 0 ? (
                <p className="text-subtle mt-4 text-[11px]">
                  {untiered.toLocaleString()} record{untiered === 1 ? '' : 's'} arrived without a tier.
                </p>
              ) : null}
            </CardBody>
          </Card>
        </div>

        {/* ROW 6 — the widest table on the page, so it gets the full row. */}
        <div className="col-span-12">
          <Suspense fallback={<PanelSkeleton rows={6} />}>
            <PipelineSection />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
