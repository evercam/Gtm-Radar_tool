import Link from 'next/link';
import { Suspense, cache } from 'react';
import { isSupabaseServerConfigured, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import {
  getEnrichmentQueue,
  getEnrichmentRuns,
  getEnrichedTodayCount,
  getPriorityRollup,
  hasPriorityColumns,
  getSourceStats,
} from '@/lib/queries';
import { getEnrichmentPolicy, getScoringPolicy } from '@/lib/policies';
import { getAllCredentialStatuses } from '@/lib/adapters/credentialStatus';
import { isClaudeConfigured } from '@/lib/enrich/claude';
import { isApolloConfigured } from '@/lib/enrich/apollo';
import { SOURCE_CATALOG } from '@/lib/sourceCatalog';
import { BAND_COLORS, BAND_LABELS } from '@/lib/semantics';
import { Card, CardHeader, CardBody, Badge, Stat, ProgressBar, EmptyState, Skeleton } from '@/components/ui';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import { requirePermission } from '@/lib/auth/session';
import { isAuthInstalled } from '@/lib/auth/installed';
import { getLastCronRun } from '@/lib/cronStatus';

export const dynamic = 'force-dynamic';

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/*
  The three expensive reads, each fetched ONCE per request however many panels
  want it.

  `cache()` is load-bearing rather than tidy. Source stats feed the Records stat and
  the Sources card; the priority rollup feeds the Scored stat and the band bars; the
  queue count feeds a stat and a line of prose. Streaming them means separate
  components ask for the same thing, and without deduplication this page would issue
  six expensive queries where it used to issue three — on a database where these
  reads already slow each other down (the priority rollup is 0.9 s alone and 7.5 s
  alongside eleven siblings).

  Declared at module scope because React's cache is per-request: each render gets its
  own memo, so nothing leaks between users or requests.
*/
const sourceStatsOnce = cache(getSourceStats);
const priorityRollupOnce = cache(getPriorityRollup);

/**
 * The eligible-queue count, with the policy it depends on.
 *
 * Wrapped as a no-argument function on purpose: `cache()` keys on arguments by
 * identity, so passing the policy object in would defeat it — a fresh object every
 * call is a fresh cache entry. Fetching the policy inside keeps the key empty. The
 * policy read is itself cheap and separately cached by the shell's own call.
 */
const queueTotalOnce = cache(async (): Promise<number | null> => {
  const { config } = await getEnrichmentPolicy();
  const { total } = await getEnrichmentQueue({
    recordTypes: config.recordTypes,
    minPriority: config.minPriorityScore,
    reenrichAfterDays: config.reenrichAfterDays,
    onlyMissingContact: config.onlyMissingContact,
    limit: 1,
  });
  return total;
});

/** A stat-shaped placeholder, so the grid does not jump when the number lands. */
function StatSkeleton({ label }: { label: string }) {
  return (
    <div className="border-border-base bg-surface rounded-2xl border p-4 shadow-[var(--shadow-card)]">
      <div className="text-muted text-[11px]">{label}</div>
      <Skeleton className="mt-2 h-6 w-16 rounded" />
      <Skeleton className="mt-1.5 h-2.5 w-24 rounded" />
    </div>
  );
}

async function RecordsStat() {
  const stats = await sourceStatsOnce();
  const sources = Object.keys(stats).length;
  const records = Object.values(stats).reduce((sum, s) => sum + s.count, 0);
  return <Stat label="Records" value={records.toLocaleString()} note={`${sources} sources ingested`} />;
}

async function ScoredStat({ migrated }: { migrated: boolean }) {
  const rollup = await priorityRollupOnce();
  const scored = rollup[0]?.scored ?? 0;
  return (
    <Stat
      label="Scored"
      value={scored.toLocaleString()}
      note={migrated ? `${rollup.find((b) => b.band === 'P1')?.count.toLocaleString() ?? 0} in P1` : 'migration pending'}
    />
  );
}

async function QueueStat() {
  const total = await queueTotalOnce();
  return (
    <Stat
      label="Enrichment queue"
      // Not `?? 0`. An unmeasurable count is not zero, and on the front page
      // a zero here reads as "there is no work".
      value={total === null ? '—' : total.toLocaleString()}
      note={total === null ? 'count unavailable — not zero' : 'eligible under policy'}
    />
  );
}

/** The band bars in the scoring card. */
async function BandBars({ migrated }: { migrated: boolean }) {
  const rollup = await priorityRollupOnce();
  const scored = rollup[0]?.scored ?? 0;

  if (!migrated) return <p className="text-muted text-sm">Apply the pending migrations to enable scoring.</p>;
  if (scored === 0)
    return (
      <p className="text-muted text-sm">
        Nothing scored yet. Run{' '}
        <Link href="/control/routing" className="text-brand underline">
          Score &amp; route all
        </Link>{' '}
        to rank the pipeline.
      </p>
    );

  return (
    <div className="space-y-2">
      {rollup.map((b) => (
        <div key={b.band} className="flex items-center gap-3">
          <Badge className={BAND_COLORS[b.band]} title={BAND_LABELS[b.band]}>
            {b.band}
          </Badge>
          <ProgressBar value={b.count} max={Math.max(1, scored)} tone="neutral" className="flex-1" />
          <span className="text-muted w-16 shrink-0 text-right text-xs tabular-nums">{b.count.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

/** The source list, plus the ingested count that used to live in the card subtitle. */
async function SourcesList() {
  const stats = await sourceStatsOnce();
  const entries = Object.entries(stats).sort((a, b) => b[1].count - a[1].count);

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No records ingested yet"
        description="Run a search against a keyless source, or configure a key and ingest."
      />
    );
  }

  return (
    <>
      <p className="text-muted mb-3 text-xs">
        {entries.length} of {SOURCE_CATALOG.length} adapters have ingested records
      </p>
      <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {entries.slice(0, 12).map(([key, stat]) => (
          <div key={key} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-foreground min-w-0 truncate">{key}</span>
            <span className="text-muted shrink-0 text-xs tabular-nums">
              {stat.count.toLocaleString()} · {stat.avgCompleteness}%
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/** The one line of prose that needs the queue count. */
async function QueueLine() {
  const total = await queueTotalOnce();
  return <>{total === null ? 'The eligible count is unavailable.' : `${total.toLocaleString()} records are eligible.`}</>;
}

/**
 * The operator console: live system state with the primary action for each
 * area inline. Deliberately not a menu of links — every panel answers "is this
 * healthy, and what do I do next" without a further click.
 */
export default async function ControlCenterPage() {
  await requirePermission('control.access', '/control');

  if (!isSupabaseServerConfigured()) {
    return (
      <div>
        <SupabaseNotConfigured />
      </div>
    );
  }

  /*
    Only the reads the SHELL cannot render without, and all of them are cheap —
    1.2 s for the policy and ~2.3 s for the rest, measured under concurrency.

    The three expensive ones are gone from here: source stats (7.4 s), the priority
    rollup (7.5 s) and the enrichment queue count (10.3 s) held this page at 10-13 s
    while everything above was ready in two. They now stream into their own
    boundaries further down, so the page paints and fills in.
  */
  const { config: enrichPolicy } = await getEnrichmentPolicy();

  const [{ isDefault: scoringIsDefault }, migrated, credStatuses, runs, enrichedToday, authInstalled, claudeReady, apolloReady, lastCron] =
    await Promise.all([
      getScoringPolicy(),
      hasPriorityColumns(),
      getAllCredentialStatuses(),
      getEnrichmentRuns(5),
      getEnrichedTodayCount(),
      isAuthInstalled(),
      isClaudeConfigured(),
      isApolloConfigured(),
      getLastCronRun(),
    ]);

  const keyed = SOURCE_CATALOG.filter((s) => s.auth === 'keyed');
  const keyedConfigured = keyed.filter((s) => {
    const slug = s.slug;
    return slug ? credStatuses[slug]?.configured : false;
  }).length;

  // Records, scored and queue totals are derived inside their own streamed
  // components now, so the shell no longer computes — or waits for — any of them.
  const capLeft = enrichPolicy.dailyCap > 0 ? Math.max(0, enrichPolicy.dailyCap - enrichedToday) : null;

  const health: { label: string; ok: boolean; detail: string; fix?: { href: string; label: string } }[] = [
    {
      label: 'Database',
      ok: isSupabaseServiceConfigured(),
      detail: isSupabaseServiceConfigured() ? 'Service role connected' : 'Service key missing — writes disabled',
    },
    {
      label: 'Schema',
      ok: migrated,
      detail: migrated ? 'Priority & enrichment migrations applied' : 'Pending migrations — see supabase/RUN_THESE.md',
    },
    {
      label: 'Claude',
      ok: claudeReady,
      detail: claudeReady ? 'Account resolution & call prep ready' : 'ANTHROPIC_API_KEY not set',
      fix: { href: '/admin/settings', label: 'Configure' },
    },
    {
      label: 'Apollo',
      ok: apolloReady,
      detail: apolloReady ? 'Verified contacts ready' : 'APOLLO_API_KEY not set',
      fix: { href: '/admin/settings', label: 'Configure' },
    },
    {
      label: 'Source credentials',
      ok: keyedConfigured === keyed.length,
      detail: `${keyedConfigured} of ${keyed.length} keyed sources configured`,
      fix: { href: '/admin/settings', label: 'Configure' },
    },
    {
      label: 'Authentication',
      ok: authInstalled,
      detail: authInstalled ? 'Sign-in, roles and RLS active' : 'Not installed — every page is public',
      fix: authInstalled ? undefined : { href: '/control/users', label: 'Manage users' },
    },
    {
      label: 'Scheduler',
      ok: lastCron.configured && lastCron.recent,
      detail: !lastCron.configured
        ? 'CRON_SECRET not set — nothing runs on a schedule'
        : lastCron.lastRanAt
          ? `Last ran ${ago(lastCron.lastRanAt)}${lastCron.recent ? '' : ' — may have stopped'}`
          : 'Configured, but has never fired',
    },
    {
      label: 'Scoring policy',
      ok: !scoringIsDefault,
      detail: scoringIsDefault ? 'Using built-in defaults' : 'Custom policy saved',
      fix: { href: '/control/routing#scoring', label: 'Tune' },
    },
  ];
  const degraded = health.filter((h) => !h.ok).length;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-foreground text-2xl font-bold">Control Center</h1>
        <Badge tone={degraded === 0 ? 'success' : degraded > 2 ? 'danger' : 'warning'}>
          {degraded === 0 ? 'All systems ready' : `${degraded} need${degraded === 1 ? 's' : ''} attention`}
        </Badge>
      </div>
      <p className="text-muted mb-8 max-w-3xl text-sm">
        Everything operational in one place — ingestion, scoring, enrichment and the rules that govern them.
      </p>

      {/* system health */}
      <section className="mb-8">
        <h2 className="text-muted mb-3 text-xs font-semibold uppercase tracking-wide">System health</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {health.map((h) => (
            <Card key={h.label} className="flex items-start justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="text-foreground text-sm font-medium">{h.label}</p>
                <p className="text-muted mt-0.5 text-xs">{h.detail}</p>
                {!h.ok && h.fix ? (
                  <Link href={h.fix.href} className="text-brand mt-1 inline-block text-xs underline">
                    {h.fix.label}
                  </Link>
                ) : null}
              </div>
              <span className={`mt-1 shrink-0 text-sm ${h.ok ? 'text-success' : 'text-warning'}`}>
                {h.ok ? '●' : '○'}
              </span>
            </Card>
          ))}
        </div>
      </section>

      {/* pipeline at a glance */}
      <section className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/*
          Three of these four stream. Each has its own boundary rather than one
          around the row, so a fast stat is not held back by a slow neighbour —
          the queue count is the slowest read on the page at 10.3 s and would
          otherwise decide when all four appear.
        */}
        <Suspense fallback={<StatSkeleton label="Records" />}>
          <RecordsStat />
        </Suspense>
        <Suspense fallback={<StatSkeleton label="Scored" />}>
          <ScoredStat migrated={migrated} />
        </Suspense>
        <Suspense fallback={<StatSkeleton label="Enrichment queue" />}>
          <QueueStat />
        </Suspense>
        <Stat
          label="Enriched (24h)"
          value={enrichedToday.toLocaleString()}
          note={
            capLeft === null
              ? 'no daily cap'
              : `${capLeft.toLocaleString()} left of ${enrichPolicy.dailyCap.toLocaleString()}`
          }
          tone={capLeft !== null && capLeft === 0 ? 'danger' : undefined}
        />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* scoring & routing */}
        <Card>
          <CardHeader
            title="Scoring & routing"
            subtitle="Rank every record, then assign its lane"
            action={
              <Link href="/control/routing" className="text-brand text-xs underline">
                Open
              </Link>
            }
          />
          <CardBody>
            <Suspense
              fallback={
                <div className="space-y-2">
                  {['P1', 'P2', 'P3', 'P4'].map((band) => (
                    <div key={band} className="flex items-center gap-3">
                      <Badge className={BAND_COLORS[band]}>{band}</Badge>
                      <Skeleton className="h-2 flex-1 rounded" />
                      <Skeleton className="h-3 w-16 shrink-0 rounded" />
                    </div>
                  ))}
                </div>
              }
            >
              <BandBars migrated={migrated} />
            </Suspense>
          </CardBody>
        </Card>

        {/* enrichment */}
        <Card>
          <CardHeader
            title="Enrichment"
            subtitle={`Batch ${enrichPolicy.batchSize} · ${enrichPolicy.concurrency} at a time · min score ${enrichPolicy.minPriorityScore}`}
            action={
              <Link href="/control/enrichment" className="text-brand text-xs underline">
                Open
              </Link>
            }
          />
          <CardBody>
            {runs.length === 0 ? (
              <p className="text-muted text-sm">
                No batch runs yet.{' '}
                <Suspense fallback={<span className="text-subtle">counting…</span>}>
                  <QueueLine />
                </Suspense>
              </p>
            ) : (
              <ul className="space-y-2">
                {runs.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted shrink-0 text-xs">{ago(r.started_at)}</span>
                    <span className="text-foreground min-w-0 flex-1 truncate">
                      {r.succeeded}/{r.requested} enriched · {r.contacts_found} contacts
                    </span>
                    <Badge tone={r.status === 'completed' ? 'success' : r.status === 'running' ? 'info' : 'danger'}>
                      {r.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* sources */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Sources"
            /* The "N have ingested" half moved into the streamed body below: it needed
               source stats, a 7.4-second read, and keeping it here would hold the card
               header — and so the whole shell — waiting for it. */
            subtitle={`${SOURCE_CATALOG.length} adapters`}
            action={
              <div className="flex gap-3">
                <Link href="/control/sources" className="text-brand text-xs underline">
                  Search
                </Link>
                <Link href="/control/sources" className="text-brand text-xs underline">
                  Source Hub
                </Link>
                <Link href="/control/sources" className="text-brand text-xs underline">
                  Catalog
                </Link>
              </div>
            }
          />
          <CardBody>
            <Suspense
              fallback={
                <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {Array.from({ length: 9 }, (_, i) => (
                    <div key={i} className="flex items-center justify-between gap-2">
                      <Skeleton className="h-3 w-32 rounded" />
                      <Skeleton className="h-3 w-16 shrink-0 rounded" />
                    </div>
                  ))}
                </div>
              }
            >
              <SourcesList />
            </Suspense>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
