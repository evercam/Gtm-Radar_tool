import Link from 'next/link';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { getEnrichmentQueue, getEnrichmentRuns, getEnrichedSinceCount, hasPriorityColumns } from '@/lib/queries';
import { getEnrichmentPolicy } from '@/lib/policies';
import { getEnrichmentRules, getPrioritisationRuns } from '@/lib/enrich/rulesStore';
import { isClaudeConfigured } from '@/lib/enrich/claude';
import { isApolloConfigured } from '@/lib/enrich/apollo';
import { BAND_COLORS as PRIORITY_BAND_COLORS, BU_SHORT as BU_LABELS } from '@/lib/semantics';
import { type PriorityBand } from '@/lib/priority';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import MigrationRequired from '@/components/MigrationRequired';
import EnrichmentRunner from '@/components/EnrichmentRunner';
import PrioritizeRunner from '@/components/control/PrioritizeRunner';
import { requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import PolicyEditor from '@/components/settings/PolicyEditor';
import { ENRICHMENT_FIELDS } from '@/lib/enrichmentFields';
import { DEFAULT_ENRICHMENT_POLICY } from '@/lib/enrich/policy';
import { Card, CardHeader } from '@/components/ui';
import RecordLink from '@/components/RecordLink';

export const dynamic = 'force-dynamic';

function money(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default async function EnrichmentPage() {
  const user = await requirePermission('enrichment.run', '/control/enrichment');

  if (!isSupabaseServerConfigured()) {
    return (
      <div>
        <SupabaseNotConfigured />
      </div>
    );
  }

  const { config: policy, isDefault } = await getEnrichmentPolicy();
  const migrated = await hasPriorityColumns();
  const [{ isDefault: rulesAreDefault }, priorRuns] = await Promise.all([
    getEnrichmentRules(),
    getPrioritisationRuns(5),
  ]);
  const [{ rows: queue, total }, runs, enrichedToday] = await Promise.all([
    // The preview must apply every eligibility clause the batch endpoint
     // applies, or the queue shows work that would never actually be picked up.
    getEnrichmentQueue({
      // Must match the batch exactly, or the page advertises a queue the run
      // would never work.
      bands: policy.bands,
      recordTypes: policy.recordTypes,
      bus: policy.bus,
      verticals: policy.verticals,
      minEstimatedValue: policy.minEstimatedValue,
      requireCompany: policy.requireCompany,
      minPriority: policy.minPriorityScore,
      reenrichAfterDays: policy.reenrichAfterDays,
      onlyMissingContact: policy.onlyMissingContact,
      limit: 25,
    }),
    getEnrichmentRuns(10),
    getEnrichedSinceCount(1),
  ]);
  const enrichedMonth = policy.monthlyCap > 0 ? await getEnrichedSinceCount(30) : 0;

  const [claudeOn, apolloOn] = await Promise.all([isClaudeConfigured(), isApolloConfigured()]);
  // Both rails apply; the tighter one is the one worth showing.
  const rails = [
    { label: 'today', used: enrichedToday, cap: policy.dailyCap },
    { label: 'this month', used: enrichedMonth, cap: policy.monthlyCap },
  ].filter((r) => r.cap > 0);
  const tightest = rails.length ? rails.reduce((a, b) => (a.cap - a.used <= b.cap - b.used ? a : b)) : null;
  const capLeft = tightest ? Math.max(0, tightest.cap - tightest.used) : null;

  const engine = (name: string, on: boolean, note: string) => (
    <div
      key={name}
      className="flex items-center justify-between gap-3 rounded-[12px] border border-border-base bg-surface px-4 py-3"
    >
      <div>
        <p className="text-sm font-medium text-foreground">{name}</p>
        <p className="text-[11px] text-muted">{note}</p>
      </div>
      <span
        className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
          on
            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
            : 'bg-surface-raised text-muted'
        }`}
      >
        {on ? '● Ready' : '○ Off'}
      </span>
    </div>
  );

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-foreground">Enrichment Control</h1>
        {isDefault ? (
          <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs text-muted">using default policy</span>
        ) : null}
      </div>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Enrichment costs money per record, so it is spent top-down: the queue is every record still missing a contact,
        ordered by lead priority. Eligibility, contact targeting and spend rails are all parameters — set them in the{' '}
        <a href="#policy" className="underline">
          policy below
        </a>
        , not in code.
      </p>

      {!migrated ? (
        <div className="mb-8">
          <MigrationRequired feature="The enrichment queue" />
        </div>
      ) : null}

      {/* engines */}
      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Engines</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {engine(
            'Claude',
            policy.engines.claude && claudeOn,
            policy.engines.claude
              ? claudeOn
                ? 'Account identification, news, SDR intel'
                : 'No Anthropic key configured'
              : 'Disabled in policy'
          )}
          {engine(
            'Apollo',
            policy.engines.apollo && apolloOn,
            policy.engines.apollo
              ? apolloOn
                ? `Verified contacts — ${policy.contactsPerAccount} per account`
                : 'No Apollo key configured'
              : 'Disabled in policy'
          )}
          {engine(
            'GLEIF',
            policy.engines.gleif,
            policy.engines.gleif ? 'Corporate hierarchy — keyless, free' : 'Disabled in policy'
          )}
        </div>
      </section>

      {/* spend posture */}
      <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'In queue', value: total.toLocaleString(), note: 'eligible under policy' },
          {
            label: 'Enriched (24h)',
            value: enrichedToday.toLocaleString(),
            note:
              capLeft === null
                ? 'no daily cap'
                : `${capLeft.toLocaleString()} left of ${tightest!.cap.toLocaleString()} ${tightest!.label}`,
          },
          {
            label: 'Min priority',
            value: String(policy.minPriorityScore),
            note: policy.bands.length ? `bands ${policy.bands.join(', ')}` : 'all bands',
          },
          {
            label: 'Batch size',
            value: String(policy.batchSize),
            note: `max ${policy.maxBatchSize} · ${policy.concurrency} at a time`,
          },
        ].map((s) => (
          <div key={s.label} className="rounded-[12px] border border-border-base bg-surface p-4">
            <p className="text-xs text-muted">{s.label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">{s.value}</p>
            <p className="mt-0.5 text-[11px] text-subtle">{s.note}</p>
          </div>
        ))}
      </section>

      <div className="mb-8">
        <PrioritizeRunner isDefaultRules={rulesAreDefault} />
      </div>

      {priorRuns.length > 0 ? (
        <section className="mb-8">
          <h2 className="text-muted mb-3 text-xs font-semibold uppercase tracking-wide">Recent selections</h2>
          <ul className="space-y-1.5">
            {priorRuns.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted shrink-0 text-xs">{ago(r.startedAt)}</span>
                <span className="text-foreground min-w-0 flex-1 truncate">
                  {r.selected.toLocaleString()} queued of {r.candidates.toLocaleString()} considered
                  {r.deferred > 0 ? ` · ${r.deferred.toLocaleString()} deferred` : ''}
                </span>
                <span className="text-subtle shrink-0 text-xs">{r.trigger}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mb-8">
        <EnrichmentRunner defaultBatchSize={policy.batchSize} maxBatchSize={policy.maxBatchSize} />
      </div>

      {can(user.role, 'settings.manage') ? (
        <div className="mb-8">
          <Card id="policy" className="scroll-mt-6">
            <CardHeader
              title="Enrichment policy"
              subtitle="Who gets enriched, what Apollo is asked for, and how much may be spent. Every run is bounded by this — a request can narrow it but never widen it."
            />
            <div className="px-5 py-4">
              <PolicyEditor
                policyName="enrichment"
                initialConfig={policy as unknown as Record<string, unknown>}
                defaults={DEFAULT_ENRICHMENT_POLICY as unknown as Record<string, unknown>}
                fields={ENRICHMENT_FIELDS}
                isDefault={isDefault}
                advancedHint="Full enrichment policy as JSON."
              />
              <p className="text-subtle mt-3 text-[11px]">
                Changes take effect on the next run. The queue above re-counts against the new policy on save, so you
                can see what a change costs you before spending anything.
              </p>
            </div>
          </Card>
        </div>
      ) : null}

      {/* the queue itself */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Queue — next up</h2>
          <Link
            href="/records?contact=needs_enrichment&sort=priority"
            className="text-xs text-muted underline hover:text-foreground"
          >
            View in records
          </Link>
        </div>
        {queue.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-strong bg-surface p-8 text-center">
            <p className="text-sm text-muted">
              Nothing eligible. Either every record has a contact, or none is scored yet — run{' '}
              <Link href="/control/routing" className="underline">
                Score &amp; route all
              </Link>{' '}
              first.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border-base bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-raised text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">Pri</th>
                  <th className="px-3 py-2">Record</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">BU</th>
                  <th className="px-3 py-2">Lane</th>
                  <th className="px-3 py-2 text-right">Value</th>
                  <th className="px-3 py-2">Last enriched</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-base">
                {queue.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-1.5">
                      {r.priority_band ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${PRIORITY_BAND_COLORS[r.priority_band as PriorityBand] ?? ''}`}
                        >
                          {r.priority_band} · {r.priority_score}
                        </span>
                      ) : (
                        <span className="text-[10px] text-subtle">unscored</span>
                      )}
                    </td>
                    {/*
                      Opens the record, not the vendor's page. Deciding whether
                      to spend an enrichment credit needs what WE hold on the
                      record; the source link is still one click away inside the
                      drawer.
                    */}
                    <td className="px-3 py-1.5 font-medium text-foreground">
                      <RecordLink id={r.id}>{r.canonical_name}</RecordLink>
                    </td>
                    <td className="px-3 py-1.5 text-xs text-muted">{r.company_name_raw ?? '—'}</td>
                    <td className="px-3 py-1.5 text-xs text-muted">{r.bu ? (BU_LABELS[r.bu] ?? r.bu) : '—'}</td>
                    <td className="px-3 py-1.5 text-xs text-muted">{r.route ? `${r.route}/${r.stage}` : '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted">{money(r.estimated_value)}</td>
                    <td className="px-3 py-1.5 text-xs text-muted">
                      {r.enriched_at ? ago(r.enriched_at) : <span className="text-subtle">never</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {total > queue.length ? (
              <p className="border-t border-border-base px-3 py-2 text-[11px] text-subtle">
                Showing the top {queue.length} of {total.toLocaleString()} eligible records.
              </p>
            ) : null}
          </div>
        )}
      </section>

      {/* run history */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border-strong bg-surface p-6 text-center text-sm text-muted">
            No batch runs yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border-base bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-raised text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Records</th>
                  <th className="px-3 py-2 text-right">Succeeded</th>
                  <th className="px-3 py-2 text-right">Contacts</th>
                  <th className="px-3 py-2 text-right">Fields</th>
                  <th className="px-3 py-2 text-right">Took</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-base">
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-1.5 text-xs text-muted">{ago(r.started_at)}</td>
                    <td className="px-3 py-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          r.status === 'completed'
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                            : r.status === 'running'
                              ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300'
                              : 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300'
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted">{r.requested}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted">
                      {r.succeeded}
                      {r.failed ? <span className="text-rose-500"> / {r.failed} failed</span> : null}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted">{r.contacts_found}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted">{r.fields_added}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted">
                      {r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
