'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Play, CalendarClock, History, ChevronDown, Sparkles, Bot } from 'lucide-react';
import type { SourceConfig } from '@/lib/sources/config';
import type { IngestionRun } from '@/lib/sources/runs';
import { Badge, Button, StatusDot, Label, controlClass } from '@/components/ui';
import Toggle from '@/components/ui/Toggle';
import { useToast } from '@/components/ui/Toast';
import SourceSearch from '@/components/SourceSearch';
import SchedulePicker from '@/components/control/SchedulePicker';
import CollectorButton from '@/components/control/CollectorButton';
import { buildCron, describeCron, parseCron, untilNextRun, type ScheduleParts } from '@/lib/cron';
import { apiLimitFor, pageSizeOptions } from '@/lib/sources/apiLimits';

/**
 * Fallback page sizes, for a source with no recorded API limit.
 *
 * Where a limit IS recorded, `pageSizeOptions` is used instead so the list stops
 * at what the vendor accepts — and includes values the old fixed ladder did not.
 * Socrata permits fifty thousand a request and this list stopped at two hundred,
 * which is how every permit pull ended up taking a fraction of one page.
 */
const PAGE_SIZES = [10, 25, 50, 100, 200];
/** Records a single scheduled run may take. */
const RUN_LIMITS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
/** Requests a source may make in a month. */
const MONTHLY_CAPS = [100, 250, 500, 1000, 2500, 5000, 10000, 50000];
/** Provider calls one record from this source is worth. */
const CALL_CEILINGS = [1, 2, 3, 4, 5, 8];

const HEALTH_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'idle'> = {
  healthy: 'ok',
  degraded: 'warn',
  failing: 'bad',
  disabled: 'idle',
  unconfigured: 'idle',
};

/** Preset choices, plus whatever is already saved — so opening the panel never changes a value. */
function options(presets: number[], current: number | undefined): number[] {
  if (current === undefined || presets.includes(current)) return presets;
  return [...presets, current].sort((a, b) => a - b);
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Plain-English rendering of a saved filter payload. */
function describeQuery(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || k === 'pageSize') continue;
    if (Array.isArray(v)) {
      if (v.length) parts.push(`${k}: ${v.slice(0, 3).join(', ')}${v.length > 3 ? ` +${v.length - 3}` : ''}`);
    } else {
      parts.push(`${k}: ${String(v)}`);
    }
  }
  return parts.length ? parts.join(' · ') : 'no filters — pulls the adapter default';
}

type Panel = 'search' | 'schedule' | 'enrich' | 'history' | 'collect' | null;

/**
 * One source, end to end: query it, save that query as the schedule, and see
 * what the schedule has been doing.
 *
 * These were three places — a search page, a seeding page and a catalog — and
 * the query you tuned in Search was thrown away rather than becoming what the
 * scheduled ingest ran. Here the loop closes: tune, save, schedule, ingest.
 */
export default function SourceHubRow({
  config,
  name,
  coverage,
  slug,
  recordCount,
  credentialed,
  keyless,
  canIngest,
  runs,
  hasCollector = false,
}: {
  config: SourceConfig;
  name: string;
  coverage: string;
  slug: string;
  recordCount: number;
  credentialed: boolean;
  keyless: boolean;
  canIngest: boolean;
  runs: IngestionRun[];
  /** True when a browser-based collector exists for this source. */
  hasCollector?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  // Whether anything has ever been posted in for this source, rather than
  // fetched by the adapter. Read from the runs already on the page.
  const pushFed = runs.some((r) => (r.params as { via?: string } | undefined)?.via === 'push');
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(config.isEnabled);
  const [schedule, setSchedule] = useState({
    ingestMode: config.ingestMode,
    pageSize: config.pageSize,
    maxRecordsPerRun: config.maxRecordsPerRun,
    monthlyRequestCap: config.monthlyRequestCap,
    dedupeStrategy: config.dedupeStrategy,
  });
  // What the vendor allows, hidden until asked for. Shown beside the controls it
  // constrains rather than in documentation somewhere else, because the moment
  // somebody needs it is the moment they are choosing a page size.
  const [showLimits, setShowLimits] = useState(false);
  const apiLimit = apiLimitFor(config.slug);
  const [when, setWhen] = useState<ScheduleParts>(() => parseCron(config.scheduleCron));
  const [enrich, setEnrich] = useState({
    enrichClaude: config.enrichClaude,
    enrichApollo: config.enrichApollo,
    enrichFillCommittee: config.enrichFillCommittee,
    maxApolloCallsPerRecord: config.maxApolloCallsPerRecord,
    maxClaudeCallsPerRecord: config.maxClaudeCallsPerRecord,
  });

  /** null means "follow the global policy" — the default for every source. */
  const tri = (v: boolean | null) => (v === null ? '' : v ? 'on' : 'off');
  const fromTri = (v: string): boolean | null => (v === '' ? null : v === 'on');
  const overridden =
    enrich.enrichClaude !== null ||
    enrich.enrichApollo !== null ||
    enrich.enrichFillCommittee !== null ||
    enrich.maxApolloCallsPerRecord !== null ||
    enrich.maxClaudeCallsPerRecord !== null;

  async function saveSchedule() {
    const cron = buildCron(when);
    const ok = await patch({ ...schedule, scheduleCron: cron });
    if (ok && schedule.ingestMode !== 'cron') {
      toast.show('Saved, but the mode is not Cron — this schedule will not run.', 'error');
    }
  }

  async function patch(body: Record<string, unknown>, successMessage?: string) {
    const res = await fetch('/api/sources/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, ...body }),
    });
    const json = await res.json();
    toast.show(successMessage && json.ok ? successMessage : json.message, json.ok ? 'success' : 'error');
    if (json.ok) router.refresh();
    return json.ok as boolean;
  }

  async function saveEnabled(next: boolean) {
    setEnabled(next);
    const ok = await patch({ isEnabled: next });
    if (!ok) setEnabled(!next); // roll back so the switch never lies about saved state
  }

  async function runNow() {
    setBusy(true);
    try {
      // No body beyond the trigger — the server runs the SAVED query, which is
      // the whole point: this button previews exactly what the schedule does.
      const res = await fetch(`/api/ingest/${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      const ok = res.ok && !json.error;
      toast.show(
        ok
          ? `${name}: ${json.inserted ?? 0} new, ${json.updated ?? 0} updated of ${json.fetched ?? 0} fetched.`
          : (json.error ?? json.message ?? 'Ingestion failed.'),
        ok ? 'success' : 'error'
      );
      router.refresh();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const hasQuery = Object.keys(config.queryParams).length > 0;
  const lastRun = runs[0];
  const toggle = (p: Panel) => setPanel(panel === p ? null : p);

  const meta = [
    coverage,
    recordCount > 0 ? `${recordCount.toLocaleString()} records` : 'no records yet',
    config.ingestMode === 'cron' && config.scheduleCron
      ? `${describeCron(config.scheduleCron)}${untilNextRun(config.scheduleCron) ? ` · next ${untilNextRun(config.scheduleCron)}` : ''}`
      : 'manual only',
    lastRun ? `last run ${ago(lastRun.startedAt)}` : 'never run',
  ].join(' · ');

  return (
    <div className="border-border-base border-b last:border-b-0">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <StatusDot tone={HEALTH_TONE[config.healthStatus] ?? 'idle'} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground text-[13px] font-bold">{name}</span>
            {keyless ? (
              <Badge tone="neutral">keyless</Badge>
            ) : credentialed ? (
              <Badge tone="success">key set</Badge>
            ) : pushFed ? (
              // A source receiving pushed data has no key and does not need
              // one. Showing "no key" here reads as broken when it is working.
              <Badge tone="success">fed by collector</Badge>
            ) : (
              <Badge tone="warning">no key</Badge>
            )}
            {hasQuery ? <Badge tone="brand">query saved</Badge> : null}
          {config.ingestMode === 'cron' && config.scheduleCron ? <Badge tone="info">scheduled</Badge> : null}
          {overridden ? <Badge tone="warning">enrichment overridden</Badge> : null}
            {config.healthStatus === 'failing' ? <Badge tone="danger">failing</Badge> : null}
          </div>
          <p className="text-muted mt-0.5 text-[11px]">{meta}</p>
          {config.lastError && config.consecutiveFailures > 0 ? (
            <p className="text-danger mt-0.5 truncate text-[11px]" title={config.lastError}>
              {config.lastError}
            </p>
          ) : null}
        </div>

        <Toggle checked={enabled} onChange={saveEnabled} label={`Enable ${name}`} hideLabel />

        <Button size="sm" onClick={() => toggle('search')} className="flex items-center gap-1.5">
          <Search size={12} strokeWidth={2.2} />
          Query
          <ChevronDown size={11} className={panel === 'search' ? 'rotate-180' : ''} />
        </Button>
        <Button size="sm" onClick={() => toggle('schedule')} className="flex items-center gap-1.5">
          <CalendarClock size={12} strokeWidth={2.2} />
          Schedule
        </Button>
        <Button size="sm" onClick={() => toggle('enrich')} className="flex items-center gap-1.5">
          <Sparkles size={12} strokeWidth={2.2} />
          Enrichment
        </Button>
        <Button size="sm" variant="ghost" onClick={() => toggle('history')} className="flex items-center gap-1.5">
          <History size={12} strokeWidth={2.2} />
          {runs.length}
        </Button>
        {hasCollector ? (
          <Button size="sm" variant="primary" onClick={() => toggle('collect')} className="flex items-center gap-1.5">
            <Bot size={12} strokeWidth={2.2} />
            Collect
            <ChevronDown size={11} className={panel === 'collect' ? 'rotate-180' : ''} />
          </Button>
        ) : null}
        {canIngest ? (
          <Button size="sm" variant="primary" onClick={runNow} disabled={busy || !enabled} className="flex items-center gap-1.5">
            <Play size={11} strokeWidth={2.4} />
            {busy ? 'Ingesting…' : 'Ingest now'}
          </Button>
        ) : null}
      </div>

      {panel === 'collect' ? (
        <div className="border-border-base bg-surface-raised border-t px-5 py-4">
          <CollectorButton slug={slug} label={name} />
        </div>
      ) : null}

      {panel === 'search' ? (
        <div className="border-border-base bg-surface-raised animate-rise-in border-t px-5 py-4">
          <p className="text-muted mb-3 text-[11px]">
            Tune the query, preview the results, then save it — a scheduled ingest runs exactly this.
            {hasQuery ? (
              <span className="text-body block">
                Currently saved: <span className="font-mono">{describeQuery(config.queryParams)}</span>
              </span>
            ) : null}
          </p>
          <SourceSearch
            fixedSource={slug as never}
            onSaveQuery={async (params) => {
              await patch({ queryParams: params });
            }}
          />
        </div>
      ) : null}

      {panel === 'schedule' ? (
        <div className="border-border-base bg-surface-raised animate-rise-in border-t px-5 py-4">
          <p className="text-muted mb-3 text-[11px]">
            {hasQuery
              ? 'A scheduled run pulls with the saved query above and writes the results straight to the database.'
              : 'No query saved yet — a scheduled run will pull this adapter\u2019s defaults. Tune one under Query first if you want something narrower.'}
          </p>

          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="block">
              <Label hint={schedule.ingestMode === 'cron' ? undefined : 'schedule inactive'}>Mode</Label>
              <select
                value={schedule.ingestMode}
                onChange={(e) => setSchedule((s) => ({ ...s, ingestMode: e.target.value as SourceConfig['ingestMode'] }))}
                className={`${controlClass} w-28`}
              >
                <option value="cron">Scheduled</option>
                <option value="manual">Manual only</option>
                <option value="realtime">Realtime</option>
              </select>
            </label>
            {schedule.ingestMode === 'cron' ? (
              <div className="min-w-0 flex-1">
                <SchedulePicker value={when} onChange={setWhen} />
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <Label hint="per API call">Page size</Label>
              <select
                value={schedule.pageSize}
                onChange={(e) => setSchedule((s) => ({ ...s, pageSize: Number(e.target.value) }))}
                className={`${controlClass} w-24`}
              >
                {options(pageSizeOptions(config.slug).length ? pageSizeOptions(config.slug) : PAGE_SIZES, schedule.pageSize).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {apiLimit ? (
              <button
                type="button"
                onClick={() => setShowLimits((v) => !v)}
                className="text-brand self-end text-[11px] underline underline-offset-2"
              >
                {showLimits ? 'hide API limits' : 'what does this source allow?'}
              </button>
            ) : null}
            <label className="block">
              <Label hint="stops a runaway pull">Max per run</Label>
              <select
                value={schedule.maxRecordsPerRun}
                onChange={(e) => setSchedule((s) => ({ ...s, maxRecordsPerRun: Number(e.target.value) }))}
                className={`${controlClass} w-32`}
              >
                {options(RUN_LIMITS, schedule.maxRecordsPerRun).map((n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString()} records
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <Label hint="requests, not records">Monthly cap</Label>
              <select
                value={schedule.monthlyRequestCap ?? ''}
                onChange={(e) =>
                  setSchedule((s) => ({
                    ...s,
                    monthlyRequestCap: e.target.value === '' ? null : Number(e.target.value),
                  }))
                }
                className={`${controlClass} w-36`}
              >
                <option value="">No cap</option>
                {options(MONTHLY_CAPS, schedule.monthlyRequestCap ?? undefined).map((n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString()} / month
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <Label>Dedupe on</Label>
              <select
                value={schedule.dedupeStrategy}
                onChange={(e) =>
                  setSchedule((s) => ({ ...s, dedupeStrategy: e.target.value as SourceConfig['dedupeStrategy'] }))
                }
                className={`${controlClass} w-36`}
              >
                <option value="source_id">Source ID</option>
                <option value="name_location">Name + location</option>
                <option value="domain">Company domain</option>
                <option value="email">Contact email</option>
              </select>
            </label>
            <Button size="sm" variant="primary" onClick={saveSchedule}>
              Save schedule
            </Button>
          </div>
          {showLimits && apiLimit ? (
            <div className="border-border-base bg-surface-raised mt-3 rounded-lg border px-3 py-2.5 text-[11px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-foreground font-semibold">{apiLimit.label}</span>
                <Badge tone={apiLimit.verified ? 'success' : 'warning'}>
                  {apiLimit.verified ? 'documented' : 'assumed'}
                </Badge>
              </div>
              <dl className="text-muted mt-2 grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1">
                <dt>Most per request</dt>
                <dd className="text-foreground">{apiLimit.maxPerRequest.toLocaleString()}</dd>
                <dt>We recommend</dt>
                <dd className="text-foreground">{apiLimit.recommendedPageSize.toLocaleString()} a request</dd>
                <dt>Paging</dt>
                <dd className="text-foreground">{apiLimit.paging}</dd>
                {apiLimit.maxTotalResults ? (
                  <>
                    <dt>Total results cap</dt>
                    <dd className="text-warning">
                      {apiLimit.maxTotalResults.toLocaleString()} — no page size gets past it
                    </dd>
                  </>
                ) : null}
                {apiLimit.maxDateSpanDays ? (
                  <>
                    <dt>Longest date span</dt>
                    <dd className="text-foreground">{apiLimit.maxDateSpanDays} days a query</dd>
                  </>
                ) : null}
                {apiLimit.requestsPerMinute ? (
                  <>
                    <dt>Stay under</dt>
                    <dd className="text-foreground">{apiLimit.requestsPerMinute} requests a minute</dd>
                  </>
                ) : null}
              </dl>
              <p className="text-body mt-2 leading-relaxed">{apiLimit.note}</p>
              {apiLimit.doc ? (
                <a href={apiLimit.doc} target="_blank" rel="noreferrer" className="text-brand mt-1.5 inline-block underline underline-offset-2">
                  vendor documentation →
                </a>
              ) : null}
            </div>
          ) : null}


          {config.monthlyRequestCap !== null ? (
            <p className="text-subtle mt-3 text-[10px]">
              {config.requestsThisMonth}/{config.monthlyRequestCap} requests used this month.
            </p>
          ) : null}
        </div>
      ) : null}

      {panel === 'enrich' ? (
        <div className="border-border-base bg-surface-raised animate-rise-in border-t px-5 py-4">
          <p className="text-muted mb-3 text-[11px]">
            What enrichment may spend on a record from this source. Every control defaults to{' '}
            <strong>Use policy</strong>, so a source you have not touched behaves exactly as the global{' '}
            <a href="/control/enrichment#policy" className="underline">
              enrichment policy
            </a>{' '}
            says. Override where a source differs — Apollo barely covers energy asset owners, and news records rarely
            have an account worth resolving at all.
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <Label>Claude</Label>
              <select
                value={tri(enrich.enrichClaude)}
                onChange={(e) => setEnrich((s) => ({ ...s, enrichClaude: fromTri(e.target.value) }))}
                className={`${controlClass} w-32`}
              >
                <option value="">Use policy</option>
                <option value="on">Always on</option>
                <option value="off">Never</option>
              </select>
            </label>
            <label className="block">
              <Label>Apollo</Label>
              <select
                value={tri(enrich.enrichApollo)}
                onChange={(e) => setEnrich((s) => ({ ...s, enrichApollo: fromTri(e.target.value) }))}
                className={`${controlClass} w-32`}
              >
                <option value="">Use policy</option>
                <option value="on">Always on</option>
                <option value="off">Never</option>
              </select>
            </label>
            <label className="block">
              <Label hint="go back for missing roles">Fill committee</Label>
              <select
                value={tri(enrich.enrichFillCommittee)}
                onChange={(e) => setEnrich((s) => ({ ...s, enrichFillCommittee: fromTri(e.target.value) }))}
                className={`${controlClass} w-32`}
              >
                <option value="">Use policy</option>
                <option value="on">Always on</option>
                <option value="off">Never</option>
              </select>
            </label>
            <label className="block">
              <Label hint="per record">Max Apollo calls</Label>
              <select
                value={enrich.maxApolloCallsPerRecord ?? ''}
                onChange={(e) =>
                  setEnrich((s) => ({
                    ...s,
                    maxApolloCallsPerRecord: e.target.value === '' ? null : Number(e.target.value),
                  }))
                }
                className={`${controlClass} w-32`}
              >
                <option value="">No ceiling</option>
                {CALL_CEILINGS.map((n) => (
                  <option key={n} value={n}>
                    {n} call{n === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <Label hint="per record">Max Claude calls</Label>
              <select
                value={enrich.maxClaudeCallsPerRecord ?? ''}
                onChange={(e) =>
                  setEnrich((s) => ({
                    ...s,
                    maxClaudeCallsPerRecord: e.target.value === '' ? null : Number(e.target.value),
                  }))
                }
                className={`${controlClass} w-32`}
              >
                <option value="">No ceiling</option>
                {CALL_CEILINGS.map((n) => (
                  <option key={n} value={n}>
                    {n} call{n === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" variant="primary" onClick={() => patch(enrich, 'Enrichment settings saved.')}>
              Save
            </Button>
            {overridden ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setEnrich({
                    enrichClaude: null,
                    enrichApollo: null,
                    enrichFillCommittee: null,
                    maxApolloCallsPerRecord: null,
                    maxClaudeCallsPerRecord: null,
                  })
                }
              >
                Follow policy for everything
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {panel === 'history' ? (
        <div className="border-border-base bg-surface-raised animate-rise-in border-t px-5 py-4">
          {runs.length === 0 ? (
            <p className="text-muted text-[11px]">No runs yet. Use Ingest now to pull with the saved query.</p>
          ) : (
            <ul className="space-y-1.5">
              {runs.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 text-[11px]">
                  <span className="text-muted w-20 shrink-0">{ago(r.startedAt)}</span>
                  <Badge tone={r.status === 'completed' ? 'success' : r.status === 'running' ? 'info' : 'danger'}>
                    {r.status}
                  </Badge>
                  <span className="text-body">
                    {r.inserted} new · {r.updated} updated · {r.fetched} fetched
                  </span>
                  <span className="text-subtle">{r.trigger}</span>
                  {r.durationMs ? <span className="text-subtle">{Math.round(r.durationMs / 100) / 10}s</span> : null}
                  {r.error ? <span className="text-danger min-w-0 flex-1 truncate">{r.error}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
