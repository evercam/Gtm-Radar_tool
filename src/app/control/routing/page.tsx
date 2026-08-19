import Link from 'next/link';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { getRoutingPolicy, getCachedRoutingPreview } from '@/lib/queries';
import { getScoringPolicies, getScoringPolicy } from '@/lib/policies';
import { DEFAULT_PRIORITY_CONFIG } from '@/lib/priority';
import { scoringFields } from '@/lib/policyFields';
import PolicyEditor from '@/components/settings/PolicyEditor';
import { can } from '@/lib/auth/roles';
import { BAND_COLORS, BAND_LABELS } from '@/lib/semantics';
import { Card, CardHeader, Stat, ProgressBar } from '@/components/ui';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import RoutingEditor from '@/components/RoutingEditor';
import ApplyRoutingButton from '@/components/ApplyRoutingButton';
import { requirePermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const LANE_BAR: Record<string, string> = {
  'sales/act_now': 'bg-emerald-500',
  'sales/qualify': 'bg-emerald-400',
  'marketing/nurture': 'bg-amber-400',
  'partner/hold': 'bg-violet-400',
  'none/hold': 'bg-zinc-400',
  'none/disqualify': 'bg-zinc-300',
};
const ROUTE_TEXT: Record<string, string> = {
  sales: 'text-emerald-700 dark:text-emerald-300',
  marketing: 'text-amber-700 dark:text-amber-300',
  partner: 'text-violet-700 dark:text-violet-300',
  none: 'text-muted',
};

export default async function RoutingPage() {
  const user = await requirePermission('routing.edit', '/control/routing');

  if (!isSupabaseServerConfigured()) return <SupabaseNotConfigured />;

  const [{ rules, isDefault }, scoringSet, scoring] = await Promise.all([
    getRoutingPolicy(),
    getScoringPolicies(),
    getScoringPolicy(),
  ]);
  const { isDefault: scoringIsDefault, overridden } = scoringSet;
  /*
    Cached, keyed on these exact rules and scoring.

    Live, this was 41.5 s against 111,353 records — of which ~31 s is transferring the
    rows, so it could not be tuned down. The key is the inputs, so editing a rule is a
    miss and recomputes: this screen must never show a preview of the PREVIOUS ruleset,
    which is the one moment it would be actively misleading rather than merely stale.
  */
  const preview = await getCachedRoutingPreview(rules, scoringSet);

  const maxLane = Math.max(1, ...preview.byLane.map((l) => l.count));
  const countsByRule = Object.fromEntries(preview.byRule.map((r) => [r.rule, r.count]));

  const salesCount = preview.byLane.filter((l) => l.route === 'sales').reduce((s, l) => s + l.count, 0);
  const actNow = preview.byLane.find((l) => l.route === 'sales' && l.stage === 'act_now')?.count ?? 0;
  // Records no rule claimed — they take the fallback disposition.
  const unrouted = countsByRule.default ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-foreground text-2xl font-bold">Routing &amp; Disposition</h1>
          {isDefault ? (
            <span className="bg-surface-raised text-muted rounded-full px-2 py-0.5 text-[10px]">
              using default rules
            </span>
          ) : null}
        </div>
        <p className="text-muted mt-1 max-w-3xl text-sm">
          Rules split every record into a lane — who owns it and what to do next. A dry-run over all{' '}
          {preview.total.toLocaleString()} records; nothing is written until you materialize at the bottom.
        </p>
        {/*
          It used to say "a LIVE dry-run", and that stopped being true the moment this
          was cached. Saying so is not decoration: this screen gates a bulk re-route, so
          somebody about to materialize needs to know whether they are looking at the
          table as it is now or as it was at 06:00.

          Editing a rule always recomputes — the rules are in the cache key — so the only
          thing that can be stale here is the RECORDS, which is exactly what this says.
        */}
        <p className="text-muted mt-1 text-xs">
          {preview.computedAt ? (
            <>
              Record counts as of{' '}
              <time dateTime={preview.computedAt}>
                {new Date(preview.computedAt).toLocaleString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
              . Rule changes are previewed immediately; the record set refreshes after each ingestion.
            </>
          ) : (
            <>Scored just now, against the current records.</>
          )}
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Records" value={preview.total.toLocaleString()} note={`avg priority ${preview.avgPriority}`} />
        <Stat
          label="To sales"
          value={salesCount.toLocaleString()}
          note={`${actNow.toLocaleString()} act now`}
          tone={salesCount > 0 ? 'success' : undefined}
        />
        <Stat
          label="Caught by a rule"
          value={`${Math.round(((preview.total - unrouted) / (preview.total || 1)) * 100)}%`}
          note={unrouted > 0 ? `${unrouted.toLocaleString()} fell through` : 'every record matched'}
        />
        <Stat
          label="Scoring policy"
          value={scoringIsDefault ? 'Default' : overridden.length > 0 ? `${overridden.length} BU` : 'Custom'}
          note={scoringIsDefault ? 'built-in weights' : overridden.length > 0 ? 'overrides in force' : 'saved globally'}
        />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Priority bands" subtitle="Scored with the current policy, before rules run" />
          <div className="space-y-3 px-5 py-4">
            {preview.byBand.map((b) => (
              <div key={b.band}>
                <div className="mb-1 flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${BAND_COLORS[b.band]}`}>
                    {b.band}
                  </span>
                  <span className="text-body text-[11px]">{BAND_LABELS[b.band]}</span>
                  <span className="text-foreground ml-auto text-[12px] font-bold tabular-nums">
                    {b.count.toLocaleString()}
                  </span>
                  <span className="text-subtle w-9 text-right text-[10px] tabular-nums">
                    {Math.round((b.count / (preview.total || 1)) * 100)}%
                  </span>
                </div>
                <ProgressBar value={b.count} max={preview.total || 1} />
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Where they land" subtitle="Route / stage after the rules fire" />
          <div className="space-y-2.5 px-5 py-4">
            {preview.byLane.map((l) => {
              const lane = `${l.route}/${l.stage}`;
              return (
                <div key={lane} className="flex items-center gap-3">
                  <div className="w-36 shrink-0 text-[11px]">
                    <span className={`font-bold ${ROUTE_TEXT[l.route] ?? ''}`}>{l.route}</span>
                    <span className="text-subtle"> / {l.stage}</span>
                  </div>
                  <div className="bg-surface-raised h-4 flex-1 overflow-hidden rounded">
                    <div
                      className={`h-full ${LANE_BAR[lane] ?? 'bg-zinc-400'}`}
                      style={{ width: `${Math.max(2, (l.count / maxLane) * 100)}%` }}
                    />
                  </div>
                  <div className="text-foreground w-24 shrink-0 text-right text-[11px] font-bold tabular-nums">
                    {l.count.toLocaleString()}
                    <span className="text-subtle ml-1 font-normal">
                      {Math.round((l.count / (preview.total || 1)) * 100)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {can(user, 'scoring.edit') ? (
        <Card id="scoring" className="scroll-mt-6">
          <CardHeader
            title="Lead scoring parameters"
            subtitle="What makes a lead urgent — these weights produce the 0–100 score and the P1–P4 bands the rules below match on"
          />
          <div className="px-5 py-4">
            <PolicyEditor
              policyName="scoring"
              initialConfig={scoring.config as unknown as Record<string, unknown>}
              defaults={DEFAULT_PRIORITY_CONFIG as unknown as Record<string, unknown>}
              fields={scoringFields({ icp: preview.facets.icp, vertical: preview.facets.vertical })}
              isDefault={scoring.isDefault}
              advancedHint="Full config, including the phase-timing table (substring → weight 0–1, first match wins) and the per-record-type timing fallbacks."
              help={{
                title: 'Every record gets a 0\u2013100 score, then a band.',
                body: (
                  <div className="space-y-2">
                    <p>
                      Six components are scored 0\u20131 and multiplied by the weights below, which sum to 100. A
                      record earning everything scores 100; one with no value, no contact and no key-account signal
                      cannot reach the top however good it looks.
                    </p>
                    <ul className="ml-4 list-disc space-y-0.5">
                      <li>
                        <strong>Timing</strong> \u2014 how close to breaking ground, read from the phase and the dates.
                      </li>
                      <li>
                        <strong>Scale</strong> \u2014 project value or MW, flattening out at the saturation points below.
                      </li>
                      <li>
                        <strong>ICP fit</strong> \u2014 the fit lists: a strategic profile takes the full weight, a
                        secondary one half, and a core vertical adds a further quarter on top.
                      </li>
                      <li>
                        <strong>Contact</strong> \u2014 whether there is a named human to call today.
                      </li>
                      <li>
                        <strong>Key account</strong> \u2014 the account-level flag from enrichment.
                      </li>
                      <li>
                        <strong>Freshness</strong> \u2014 how recently it appeared.
                      </li>
                    </ul>
                    <p>
                      The <strong>band thresholds</strong> then cut the result into P1\u2013P4. They are the only
                      numbers here with no natural value \u2014 they are wherever divides your book into piles a team
                      can work, so set them against the real distribution above rather than by intuition. A threshold
                      above what anything can actually score leaves that band permanently empty.
                    </p>
                    <p>
                      Changing any of this affects new scoring immediately; <strong>Materialize</strong> at the bottom
                      of the page restates the records already in the database.
                    </p>
                  </div>
                ),
              }}
            />
            <p className="text-subtle mt-3 text-[11px]">
              This is the global policy every business unit inherits.{' '}
              {scoringSet.overridden.length > 0
                ? `${scoringSet.overridden.map((b) => b.toUpperCase()).join(', ')} currently override it.`
                : 'No business unit overrides it yet.'}{' '}
              A partial override layers on top of this one, so shared changes still reach every BU that has not
              diverged. Changes affect new scoring immediately — materialize below to restate existing records.
            </p>
          </div>
        </Card>
      ) : null}

      <RoutingEditor initialRules={rules} facets={preview.facets} countsByRule={countsByRule} />

      <Card>
        <CardHeader
          title="Materialize"
          subtitle="Write the priority score and disposition onto every record so the lanes become workable"
        />
        <div className="px-5 py-4">
          <p className="text-muted mb-3 text-[11px]">
            Re-run any time the rules or the scoring parameters change. Then work them on{' '}
            <Link href="/records" className="underline">
              Records
            </Link>{' '}
            by route/stage/band, or through the{' '}
            <Link href="/control/enrichment" className="underline">
              enrichment queue
            </Link>{' '}
            in priority order.
          </p>
          <ApplyRoutingButton />
        </div>
      </Card>
    </div>
  );
}
