import Link from 'next/link';
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
import { Card, CardHeader, CardBody, Badge, Stat, ProgressBar, EmptyState } from '@/components/ui';
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
    The policy is fetched FIRST, on its own, because the queue count needs it.

    It used to be one of twelve promises here, with the queue count awaited
    afterwards — so a 6.6-second count was serialised behind the whole batch for no
    reason other than argument order. Pulling the policy out (0.9 s) lets the count
    join the batch, and the page waits for the slowest read rather than for two in
    sequence.
  */
  const { config: enrichPolicy } = await getEnrichmentPolicy();

  const [
    { isDefault: scoringIsDefault },
    migrated,
    credStatuses,
    sourceStats,
    priorityRollup,
    runs,
    enrichedToday,
    authInstalled,
    claudeReady,
    apolloReady,
    lastCron,
    { total: queueTotal },
  ] = await Promise.all([
    getScoringPolicy(),
    hasPriorityColumns(),
    getAllCredentialStatuses(),
    getSourceStats(),
    getPriorityRollup(),
    getEnrichmentRuns(5),
    getEnrichedTodayCount(),
    isAuthInstalled(),
    isClaudeConfigured(),
    isApolloConfigured(),
    getLastCronRun(),
    getEnrichmentQueue({
      recordTypes: enrichPolicy.recordTypes,
      minPriority: enrichPolicy.minPriorityScore,
      reenrichAfterDays: enrichPolicy.reenrichAfterDays,
      onlyMissingContact: enrichPolicy.onlyMissingContact,
      limit: 1,
    }),
  ]);

  const keyed = SOURCE_CATALOG.filter((s) => s.auth === 'keyed');
  const keyedConfigured = keyed.filter((s) => {
    const slug = s.slug;
    return slug ? credStatuses[slug]?.configured : false;
  }).length;

  const ingestedSources = Object.keys(sourceStats).length;
  const totalRecords = Object.values(sourceStats).reduce((sum, s) => sum + s.count, 0);
  const scored = priorityRollup[0]?.scored ?? 0;
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
        <Stat label="Records" value={totalRecords.toLocaleString()} note={`${ingestedSources} sources ingested`} />
        <Stat
          label="Scored"
          value={scored.toLocaleString()}
          note={
            migrated
              ? `${priorityRollup.find((b) => b.band === 'P1')?.count.toLocaleString() ?? 0} in P1`
              : 'migration pending'
          }
        />
        <Stat
          label="Enrichment queue"
          // Not `?? 0`. An unmeasurable count is not zero, and on the front page
          // a zero here reads as "there is no work".
          value={queueTotal === null ? '—' : queueTotal.toLocaleString()}
          note={queueTotal === null ? 'count unavailable — not zero' : 'eligible under policy'}
        />
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
            {!migrated ? (
              <p className="text-muted text-sm">Apply the pending migrations to enable scoring.</p>
            ) : scored === 0 ? (
              <p className="text-muted text-sm">
                Nothing scored yet. Run{' '}
                <Link href="/control/routing" className="text-brand underline">
                  Score &amp; route all
                </Link>{' '}
                to rank the pipeline.
              </p>
            ) : (
              <div className="space-y-2">
                {priorityRollup.map((b) => (
                  <div key={b.band} className="flex items-center gap-3">
                    <Badge className={BAND_COLORS[b.band]} title={BAND_LABELS[b.band]}>
                      {b.band}
                    </Badge>
                    <ProgressBar value={b.count} max={Math.max(1, scored)} tone="neutral" className="flex-1" />
                    <span className="text-muted w-16 shrink-0 text-right text-xs tabular-nums">
                      {b.count.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
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
                {queueTotal === null ? 'The eligible count is unavailable.' : `${queueTotal.toLocaleString()} records are eligible.`}
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
            subtitle={`${SOURCE_CATALOG.length} adapters · ${ingestedSources} have ingested records`}
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
            {ingestedSources === 0 ? (
              <EmptyState
                title="No records ingested yet"
                description="Run a search against a keyless source, or configure a key and ingest."
              />
            ) : (
              <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(sourceStats)
                  .sort((a, b) => b[1].count - a[1].count)
                  .slice(0, 12)
                  .map(([key, stat]) => (
                    <div key={key} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-foreground min-w-0 truncate">{key}</span>
                      <span className="text-muted shrink-0 text-xs tabular-nums">
                        {stat.count.toLocaleString()} · {stat.avgCompleteness}%
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
