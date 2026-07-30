import Link from 'next/link';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { isSupabaseServerConfigured, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { listGemDir } from '@/lib/gem/local';
import { GEM_SOURCE_KEY } from '@/lib/gem/normalize';
import { KEY_ACCOUNT_SOURCE } from '@/lib/import/keyaccounts';
import { getAllSourceConfigs, catalogFor } from '@/lib/sources/config';
import { getAllCredentialStatuses } from '@/lib/adapters/credentialStatus';
import { getSourceStats } from '@/lib/queries';
import { getIngestionRuns, getActiveRuns } from '@/lib/sources/runs';
import { getLastCronRun } from '@/lib/cronStatus';
import { SOURCE_SLUGS } from '@/lib/sourceSlugs';
import { LIVE_SOURCE_SLUGS } from '@/lib/adapters';
import { Badge, Card, CardHeader, Chip, Stat, EmptyState } from '@/components/ui';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import MigrationRequired from '@/components/MigrationRequired';
import SourceHubRow from '@/components/control/SourceHubRow';
import SourceUploadRow from '@/components/control/SourceUploadRow';
import KeyAccountImportPanel from '@/components/KeyAccountImportPanel';
import GemUploadPanel from '@/components/GemUploadPanel';
import GemLocalPanel from '@/components/GemLocalPanel';

export const dynamic = 'force-dynamic';

/**
 * Source Hub — the catalog and the search, in one place.
 *
 * These were two pages: a catalog you could look at, and a search page with
 * its own source dropdown. That meant choosing a source twice and gave no way
 * to see a source's health while querying it. Here each row expands into that
 * adapter's own filters, so the source you are looking at is the source you
 * are querying.
 */
export default async function SourceHubPage({ searchParams }: { searchParams: Promise<{ cat?: string }> }) {
  const user = await requirePermission('sources.run', '/control/sources');
  const { cat } = await searchParams;

  if (!isSupabaseServerConfigured()) {
    return <SupabaseNotConfigured />;
  }

  const [{ configs, tableMissing }, credStatuses, sourceStats, { runs }, activeRuns, cron] = await Promise.all([
    getAllSourceConfigs(),
    getAllCredentialStatuses(),
    getSourceStats(),
    getIngestionRuns({ limit: 100 }),
    getActiveRuns(),
    getLastCronRun(),
  ]);

  const canUpload = can(user.role, 'sources.ingest');
  const dbReady = isSupabaseServiceConfigured();
  const gemListing = canUpload ? await listGemDir() : { ok: false, dir: '', files: [], message: null };

  // Runs grouped per source so each row shows its own history without needing
  // a query per source.
  const runsBySlug = new Map<string, typeof runs>();
  for (const r of runs) {
    const list = runsBySlug.get(r.slug) ?? [];
    if (list.length < 5) list.push(r);
    runsBySlug.set(r.slug, list);
  }

  const slugs = LIVE_SOURCE_SLUGS.filter((s) => SOURCE_SLUGS[s]);

  const rows = slugs.map((slug) => {
    const catalog = catalogFor(slug);
    const sourceKey = SOURCE_SLUGS[slug].sourceKey;
    return {
      slug,
      name: catalog?.name ?? slug,
      coverage: catalog?.coverage ?? '—',
      category: catalog?.category ?? 'Other',
      recordCount: sourceStats[sourceKey]?.count ?? 0,
      config: configs[slug],
      cred: credStatuses[slug],
      runs: runsBySlug.get(slug) ?? [],
      // Sources with no API key here, read by a browser running elsewhere.
      hasCollector: slug === 'construct-connect',
    };
  });

  const categories = Array.from(new Set(rows.map((r) => r.category))).sort();
  const active = cat && categories.includes(cat) ? cat : null;
  const visible = active ? rows.filter((r) => r.category === active) : rows;

  // Grouped so a long list stays scannable — the reference groups by kind, we
  // group by what the source actually produces.
  const grouped = categories
    .filter((c) => !active || c === active)
    .map((c) => ({ category: c, items: visible.filter((r) => r.category === c) }))
    .filter((g) => g.items.length > 0);

  const totalRecords = Object.values(sourceStats).reduce((s, v) => s + v.count, 0);
  const enabled = rows.filter((r) => r.config.isEnabled).length;
  const scheduled = rows.filter(
    (r) => r.config.isEnabled && r.config.ingestMode === 'cron' && r.config.scheduleCron
  ).length;
  const withQuery = rows.filter((r) => Object.keys(r.config.queryParams).length > 0).length;
  const failing = rows.filter((r) => r.config.healthStatus === 'failing').length;
  const needKey = rows.filter((r) => !r.cred?.keyless && !r.cred?.configured).length;
  const canIngest = can(user.role, 'sources.ingest');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold">Source Hub</h1>
        <p className="text-muted mt-1 max-w-3xl text-sm">
          Build a query against a source, save it as that source&apos;s scheduled pull, and watch what it ingests.
          Querying writes nothing; <strong>Ingest now</strong> runs the saved query and persists the results.
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Scheduled" value={`${scheduled}/${enabled}`} note="enabled sources on a cron" />
        <Stat label="Saved queries" value={`${withQuery}/${rows.length}`} note="sources with a tuned pull" />
        <Stat label="Records ingested" value={totalRecords.toLocaleString()} note={`${runs.length} runs recorded`} />
        <Stat
          label="Needs attention"
          value={needKey + failing}
          note={needKey + failing === 0 ? 'all healthy and configured' : `${needKey} missing keys, ${failing} failing`}
          tone={needKey + failing > 0 ? 'warning' : undefined}
        />
      </section>

      {!cron.configured ? (
        <div className="border-warning/40 bg-warning/10 text-warning rounded-2xl border px-4 py-3 text-[11px]">
          <strong>Nothing runs on a schedule yet.</strong> Saved queries only pull when triggered manually until
          CRON_SECRET is set and a scheduler calls <code className="font-mono">/api/cron?job=daily</code>.
        </div>
      ) : !cron.recent ? (
        <div className="border-warning/40 bg-warning/10 text-warning rounded-2xl border px-4 py-3 text-[11px]">
          The scheduler has not run recently — saved queries may not be pulling.
        </div>
      ) : null}

      {activeRuns.length > 0 ? (
        <div className="border-border-base bg-surface rounded-2xl border px-4 py-3">
          <p className="text-muted mb-2 text-[10px] font-bold uppercase tracking-widest">Running now</p>
          <ul className="space-y-1">
            {activeRuns.map((r) => (
              <li key={r.id} className="text-body flex items-center gap-3 text-[11px]">
                <span className="bg-brand h-1.5 w-1.5 animate-pulse rounded-full" />
                {r.slug} · {r.trigger}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {tableMissing ? <MigrationRequired feature="Source scheduling and run history" /> : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <Chip href="/control/sources" active={!active}>
          All <span className="tabular-nums">{rows.length}</span>
        </Chip>
        {categories.map((c) => (
          <Chip key={c} href={`/control/sources?cat=${encodeURIComponent(c)}`} active={active === c}>
            {c} <span className="tabular-nums">{rows.filter((r) => r.category === c).length}</span>
          </Chip>
        ))}
        {needKey > 0 ? (
          <Link href="/admin/settings" className="text-brand ml-auto text-[11px] underline">
            Configure keys
          </Link>
        ) : null}
      </div>

      {canUpload ? (
        <Card className="overflow-hidden">
          <CardHeader
            title="Upload"
            subtitle="Bring your own files — same table, same enrichment, triggered by hand instead of a schedule"
          />
          <div>
            <SourceUploadRow
              name="Key accounts (CSV)"
              coverage="Your own list"
              recordCount={sourceStats[KEY_ACCOUNT_SOURCE]?.count ?? 0}
              note="Each row becomes an account keyed by company. Headers are matched loosely — Account, Website, Country, Sector, Contact, Email and so on — so most exports work unchanged. Export from Excel as CSV first."
            >
              <KeyAccountImportPanel dbReady={dbReady} />
            </SourceUploadRow>

            <SourceUploadRow
              name="GEM trackers"
              coverage="Global Energy Monitor · worldwide"
              recordCount={sourceStats[GEM_SOURCE_KEY]?.count ?? 0}
              note="Energy, extraction and heavy-industry assets. The tracker is detected from each filename (solar.json, coal_plant.json, steel.json…), so keep GEM's original names. The owner/operator becomes the account and maps to the Critical Infrastructure Owner ICP."
            >
              <div className="space-y-4">
                <GemLocalPanel
                  initialDir={gemListing.dir}
                  initialFiles={gemListing.files}
                  initialMessage={
                    !gemListing.ok || gemListing.files.length === 0
                      ? (gemListing.message ?? 'No GEM files found in the server folder.')
                      : null
                  }
                />
                <GemUploadPanel dbReady={dbReady} />
              </div>
            </SourceUploadRow>
          </div>
        </Card>
      ) : null}

      {grouped.length === 0 ? (
        <EmptyState title="No sources in this category" description="Clear the filter to see them all." />
      ) : (
        grouped.map((group) => (
          <Card key={group.category} className="overflow-hidden">
            <CardHeader
              title={group.category}
              subtitle={`${group.items.length} source${group.items.length === 1 ? '' : 's'}`}
            />
            <div>
              {group.items.map((r) => (
                <SourceHubRow
                  key={r.slug}
                  slug={r.slug}
                  config={r.config}
                  name={r.name}
                  coverage={r.coverage}
                  recordCount={r.recordCount}
                  credentialed={r.cred?.configured ?? false}
                  keyless={r.cred?.keyless ?? false}
                  canIngest={canIngest}
                  runs={r.runs}
                  hasCollector={r.hasCollector}
                />
              ))}
            </div>
          </Card>
        ))
      )}

      {runs.some((r) => r.error) ? (
        <Card>
          <CardHeader title="Recent errors" subtitle="Most recent failure per source" />
          <div className="space-y-3 px-5 py-4">
            {Array.from(new Map(runs.filter((r) => r.error).map((r) => [r.slug, r])).values()).map((r) => (
              <div key={r.id}>
                <div className="flex items-center gap-2">
                  <span className="text-foreground text-[12px] font-bold">{r.slug}</span>
                  <Badge tone="danger">{r.errorKind ?? 'error'}</Badge>
                </div>
                <p className="text-muted mt-0.5 text-[11px]">{r.error}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
