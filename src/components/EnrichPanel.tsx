'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { provenanceChip, statusText } from '@/lib/status-colors';

interface EnrichRecord {
  id?: string | null; // when set + Supabase configured, enrichment persists to this row
  canonical_name: string;
  record_type?: string | null;
  icp_code?: string | null;
  company_name_raw?: string | null;
  company_website?: string | null;
  company_domain?: string | null;
  contact_name?: string | null;
  contact_title?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  city?: string | null;
  state_province?: string | null;
  estimated_value?: number | null;
  estimated_value_currency?: string | null;
  source_key?: string | null;
  project_url?: string | null;
}

interface Account {
  name: string | null;
  domain: string | null;
  website: string | null;
  industry: string | null;
  role: string | null;
  hq_location: string | null;
  employee_count: number | null;
  linkedin_url: string | null;
  description: string | null;
}
interface Contact {
  name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  source: string;
}
interface News {
  title: string | null;
  url: string | null;
  summary: string | null;
  published: string | null;
}
interface EnrichResponse {
  ok: boolean;
  account: Account | null;
  contacts: Contact[];
  news: News[];
  reasoning: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  engines: { claude: boolean; apollo: boolean };
  profile?: string;
  sdr?: {
    icp_fit_score: number | null;
    icp_fit_reason: string | null;
    evercam_timing: string | null;
    trigger_event: string | null;
    opening_hook: string | null;
    value_angle: string | null;
    pain_point: string | null;
  } | null;
  keyAccount?: { key_account: boolean; key_account_score: number; key_account_reasons: string[] } | null;
  applied?: { field: string; origin: 'source' | 'claude' | 'apollo' | 'gleif'; value: unknown }[];
  persisted?: boolean;
  message?: string;
  errorKind?: string;
}

/*
  Tone names, not class strings.

  These were four hand-written class strings on the -100/-800 ramp, while every
  Badge in the app uses -50/-700 with a border. Same meaning, two appearances,
  depending only on which component a reader happened to be looking at — and
  nothing kept the two in step when a token moved.

  The vocabulary was already an exact match for Badge's tones, which is the tell
  that this map should never have held colours: reach_now IS success, too_late IS
  danger. Mapping domain to tone and letting Badge own the paint is what the rest
  of the panels do (ARRIVAL_TONE, ROUTE_TONE, HEALTH_TONE).
*/
const TIMING_TONE: Record<string, 'success' | 'info' | 'neutral' | 'danger'> = {
  reach_now: 'success',
  watch: 'info',
  too_early: 'neutral',
  too_late: 'danger',
};

/*
  Origins are told apart by their name, not by a hue — see provenanceChip in
  status-colors.ts for the reasoning. apollo was emerald, the same green that
  means "success" on every badge in the app, so a column of applied fields read
  as a column of good news when it was only a list of where values came from.
*/

const FIELD_LABEL: Record<string, string> = {
  company_name_raw: 'Company',
  company_website: 'Website',
  company_domain: 'Domain',
  contact_name: 'Contact',
  contact_title: 'Title',
  contact_email: 'Email',
  contact_phone: 'Phone',
};

/* Same three tones the rest of the app already spells success/warning/danger. */
const CONFIDENCE_TONE: Record<string, 'success' | 'warning' | 'danger'> = {
  high: 'success',
  medium: 'warning',
  low: 'danger',
};

export default function EnrichPanel({ record }: { record: EnrichRecord }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<EnrichResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record),
        });
        const json = (await res.json()) as EnrichResponse;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled)
          setData({
            ok: false,
            account: null,
            contacts: [],
            news: [],
            reasoning: null,
            confidence: null,
            engines: { claude: false, apollo: false },
            message: err instanceof Error ? err.message : String(err),
          });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Enrich once when the panel opens; record identity is stable per row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-border-base border-t-transparent" />
        Enriching with Claude{data?.engines?.apollo ? ' + Apollo' : ''}… (identifying account, mining news)
      </div>
    );
  }

  if (!data || !data.ok) {
    return (
      <div className={cn('px-4 py-3 text-sm', statusText.danger)}>
        {data?.errorKind ? `[${data.errorKind}] ` : ''}
        {data?.message ?? 'Enrichment failed.'}
      </div>
    );
  }

  const { account, contacts, news, reasoning, confidence, engines, profile, sdr, keyAccount, applied, persisted } =
    data;

  return (
    <div className="space-y-4 bg-surface-raised px-4 py-4">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-semibold uppercase tracking-wide text-muted">Enrichment</span>
        {confidence ? (
          <Badge tone={CONFIDENCE_TONE[confidence] ?? 'neutral'}>confidence: {confidence}</Badge>
        ) : null}
        <span className="rounded-full bg-surface-raised px-2 py-0.5 text-muted">
          Claude {engines.claude ? '✓' : '—'} · Apollo {engines.apollo ? '✓' : '—'}
        </span>
        {profile ? (
          <Badge tone="info" title="Enrichment tuned for this source's account type">
            tuned for: {profile}
          </Badge>
        ) : null}
        {persisted ? (
          <Badge tone="success">saved to record</Badge>
        ) : null}
        {keyAccount?.key_account ? (
          <Badge tone="brand" title={keyAccount.key_account_reasons.join(' · ')}>
            ★ KEY ACCOUNT · {keyAccount.key_account_score}
          </Badge>
        ) : keyAccount ? (
          <span
            className="rounded-full bg-surface-raised px-2 py-0.5 text-muted"
            title={keyAccount.key_account_reasons.join(' · ')}
          >
            account score {keyAccount.key_account_score}
          </span>
        ) : null}
      </div>

      {/* SDR playbook — should I call, when, and what do I say */}
      {sdr && (sdr.opening_hook || sdr.icp_fit_score != null) ? (
        <div className="rounded-lg border border-border-base bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">SDR playbook</h4>
            {sdr.icp_fit_score != null ? (
              <Badge tone="neutral">ICP fit {sdr.icp_fit_score}</Badge>
            ) : null}
            {sdr.evercam_timing ? (
              <Badge tone={TIMING_TONE[sdr.evercam_timing] ?? 'neutral'}>
                {sdr.evercam_timing.replace('_', ' ')}
              </Badge>
            ) : null}
            {sdr.value_angle ? (
              <Badge tone="neutral">{sdr.value_angle}</Badge>
            ) : null}
          </div>
          {sdr.opening_hook ? (
            <p className="border-brand/40 text-foreground mt-2 border-l-2 pl-2 text-sm italic">
              &ldquo;{sdr.opening_hook}&rdquo;
            </p>
          ) : null}
          <dl className="mt-2 space-y-1 text-xs text-muted">
            {sdr.trigger_event ? (
              <div>
                <dt className="inline font-medium text-muted">Trigger: </dt>
                <dd className="inline">{sdr.trigger_event}</dd>
              </div>
            ) : null}
            {sdr.pain_point ? (
              <div>
                <dt className="inline font-medium text-muted">Pain: </dt>
                <dd className="inline">{sdr.pain_point}</dd>
              </div>
            ) : null}
            {sdr.icp_fit_reason ? (
              <div>
                <dt className="inline font-medium text-muted">Fit: </dt>
                <dd className="inline">{sdr.icp_fit_reason}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}

      {/* What enrichment added — the columns it filled, and which engine created each */}
      <div className="rounded-lg border border-border-base bg-surface p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Fields added by enrichment{applied && applied.length ? ` (${applied.length})` : ''}
        </h4>
        {applied && applied.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {applied.map((f) => (
              <li key={f.field} className="flex items-center gap-2 text-sm">
                <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-medium', provenanceChip)}>
                  {f.origin}
                </span>
                <span className="text-muted">{FIELD_LABEL[f.field] ?? f.field}:</span>
                <span className="truncate text-foreground">{String(f.value)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-sm text-muted">
            Nothing to add — the source already provided these fields (originals are never overwritten).
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Account */}
        <div className="rounded-lg border border-border-base bg-surface p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Account</h4>
          {account?.name ? (
            <div className="mt-1.5 space-y-1 text-sm">
              <p className="font-semibold text-foreground">{account.name}</p>
              {account.role ? <p className="text-xs text-muted">Role: {account.role}</p> : null}
              {account.industry ? <p className="text-xs text-muted">{account.industry}</p> : null}
              {account.hq_location ? <p className="text-xs text-muted">{account.hq_location}</p> : null}
              {account.employee_count ? (
                <p className="text-xs text-muted">~{account.employee_count.toLocaleString()} employees</p>
              ) : null}
              {account.website ? (
                <a
                  href={account.website}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-link text-xs hover:underline"
                >
                  {account.website}
                </a>
              ) : null}
              {account.linkedin_url ? (
                <a
                  href={account.linkedin_url}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-link text-xs hover:underline"
                >
                  LinkedIn
                </a>
              ) : null}
              {account.description ? <p className="mt-1 text-xs text-muted">{account.description}</p> : null}
            </div>
          ) : (
            <p className="mt-1.5 text-sm text-muted">No account identified.</p>
          )}
        </div>

        {/* Contacts */}
        <div className="rounded-lg border border-border-base bg-surface p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Contacts ({contacts.length})</h4>
          {contacts.length > 0 ? (
            <ul className="mt-1.5 space-y-2">
              {contacts.map((c, i) => (
                <li key={i} className="text-sm">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground">{c.name ?? '—'}</span>
                    <span
                      className={cn('rounded border px-1 text-[10px]', provenanceChip)}
                    >
                      {c.source}
                    </span>
                  </div>
                  {c.title ? <p className="text-xs text-muted">{c.title}</p> : null}
                  {c.email ? (
                    <a
                      href={`mailto:${c.email}`}
                      className="block text-link text-xs hover:underline"
                    >
                      {c.email}
                    </a>
                  ) : null}
                  {c.phone ? <p className="text-xs text-muted">{c.phone}</p> : null}
                  {c.linkedin_url ? (
                    <a
                      href={c.linkedin_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-link text-xs hover:underline"
                    >
                      LinkedIn
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-sm text-muted">No contacts found.</p>
          )}
        </div>

        {/* News */}
        <div className="rounded-lg border border-border-base bg-surface p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
            News &amp; signals ({news.length})
          </h4>
          {news.length > 0 ? (
            <ul className="mt-1.5 space-y-2">
              {news.map((n, i) => (
                <li key={i} className="text-sm">
                  {n.url ? (
                    <a
                      href={n.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-link font-medium hover:underline"
                    >
                      {n.title ?? n.url}
                    </a>
                  ) : (
                    <span className="font-medium text-foreground">{n.title}</span>
                  )}
                  {n.published ? <span className="ml-1 text-[11px] text-muted">{n.published}</span> : null}
                  {n.summary ? <p className="text-xs text-muted">{n.summary}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-sm text-muted">No recent news found.</p>
          )}
        </div>
      </div>

      {reasoning ? (
        <p className="text-[11px] italic text-muted">
          <span className="font-semibold not-italic">How the account was identified: </span>
          {reasoning}
        </p>
      ) : null}
    </div>
  );
}
