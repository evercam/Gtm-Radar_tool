import type React from 'react';
import Link from 'next/link';
import type { CanonicalProjectRow } from '@/lib/supabase/types';
import { Badge, SectionTitle } from '@/components/ui';
import { BU_SHORT, titleize } from '@/lib/semantics';
import { arrivalFor, type ArrivalVerdict } from '@/lib/arrival';

/**
 * The body of the record drawer — a single record's own fields.
 *
 * Server-rendered and read-only. Sections that have no data are omitted
 * entirely rather than rendered as a column of em-dashes: most records come
 * straight from a source adapter and are legitimately sparse until enrichment
 * runs, and a screen of blanks reads as broken rather than as "not yet
 * enriched". The completeness bar at the top is what communicates sparseness.
 */

function fmtDate(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function money(n: number | null, ccy: string | null): string | null {
  if (n == null) return null;
  const c = ccy || 'USD';
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${c} ${n.toLocaleString()}`;
  }
}

// Widened to ReactNode so a fact can carry a badge. `Facts` filters on the
// value being present, which holds for an element just as it does for a string.
type Row = [label: string, value: React.ReactNode | string | number | null | undefined];

/** Definition list that drops empty rows, so a sparse record stays readable. */
function Facts({ rows }: { rows: Row[] }) {
  const present = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (present.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4 gap-y-2 text-xs">
      {present.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-subtle">{label}</dt>
          <dd className="text-foreground break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const ARRIVAL_TONE: Record<ArrivalVerdict, 'success' | 'warning' | 'danger' | 'neutral'> = {
  early: 'success',
  on_time: 'success',
  late: 'warning',
  too_late: 'danger',
  unknown: 'neutral',
};

const ARRIVAL_LABEL: Record<ArrivalVerdict, string> = {
  early: 'early',
  on_time: 'on time',
  late: 'late',
  too_late: 'too late',
  unknown: 'unknown',
};

/**
 * Where this project is relative to the moment Evercam gets installed.
 *
 * The badge is the answer; the sentence beneath it is how we know. Those are
 * kept together deliberately — only 11% of in-scope records publish a
 * construction start date, so most verdicts rest on a completion date, an
 * announcement date, or the phase alone. A rep who acts on "early" deserves to
 * see whether that came from a real date or from an inference.
 */
function ArrivalLine({ record }: { record: CanonicalProjectRow }) {
  const a = arrivalFor(record);
  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-2">
        <Badge tone={ARRIVAL_TONE[a.verdict]}>{ARRIVAL_LABEL[a.verdict]}</Badge>
        {a.dated ? null : <span className="text-subtle text-[10px]">no dates — inferred</span>}
      </span>
      <span className="text-muted leading-relaxed">{a.summary}</span>
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  if (!children) return null;
  return (
    <section className="border-border-base border-t pt-4 first:border-t-0 first:pt-0">
      <SectionTitle>{title}</SectionTitle>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export default function RecordDetail({ r }: { r: CanonicalProjectRow }) {
  const place = [r.address_line1, r.city, r.state_province, r.country].filter(Boolean).join(', ');
  const coords = r.latitude != null && r.longitude != null ? `${r.latitude}, ${r.longitude}` : null;
  const completeness = r.population_percentage ?? r.source_completeness_score;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">{r.source_key}</Badge>
        {r.record_type ? <Badge>{r.record_type}</Badge> : null}
        {r.bu ? <Badge>{BU_SHORT[r.bu] ?? r.bu}</Badge> : null}
        {r.vertical ? <Badge>{titleize(r.vertical)}</Badge> : null}
        {r.icp_code ? <Badge>{titleize(r.icp_code)}</Badge> : null}
      </div>

      {completeness != null ? (
        <div>
          <div className="text-subtle mb-1 flex justify-between text-[10px]">
            <span>Field completeness</span>
            <span>
              {Math.round(completeness)}%{r.source_completeness_tier ? ` · tier ${r.source_completeness_tier}` : ''}
            </span>
          </div>
          <div className="bg-surface-muted h-1.5 w-full overflow-hidden rounded-full">
            <div className="bg-brand h-full rounded-full" style={{ width: `${Math.min(100, completeness)}%` }} />
          </div>
        </div>
      ) : null}

      {r.description ? <p className="text-muted text-xs leading-relaxed">{r.description}</p> : null}

      <Section title="Identity">
        <Facts
          rows={[
            ['Reference', r.ref_code],
            ['Company', r.company_name_raw],
            ['Source ID', r.source_unique_id],
            ['Project type', r.project_type],
            ['Technology', r.technology_type],
          ]}
        />
        {/*
          Shown with its provenance rather than as an opaque string. An `E:` group
          is an owner identifier published by the source and can be trusted to
          mean one company; an `N:` group is a slug of the owner's name, so two
          spellings may still sit in different groups. Presenting them
          identically would invite treating a name guess as a fact.
        */}
        {r.owner_group_key ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={r.owner_group_key.startsWith('E:') ? 'success' : 'neutral'}>
              {r.owner_group_key.startsWith('E:') ? 'verified owner id' : 'matched by name'}
            </Badge>
            <Link
              href={`/records?owner_group=${encodeURIComponent(r.owner_group_key)}`}
              className="text-brand underline underline-offset-2"
            >
              All leads for this owner →
            </Link>
          </div>
        ) : null}
      </Section>

      <Section title="Location">
        <Facts
          rows={[
            ['Address', place || null],
            ['Coordinates', coords],
            ['Remote site', r.is_remote_location ? 'yes' : null],
            ['Access constrained', r.is_access_constrained ? 'yes' : null],
          ]}
        />
      </Section>

      <Section title="Scale & timing">
        <Facts
          rows={[
            // How early we are arriving, ahead of the raw fields it is derived
            // from — it is the question a rep actually has, and the dates below
            // are the working. The summary always names its own basis, so a
            // verdict inferred from the phase alone cannot be mistaken for one
            // measured against a construction start date.
            ['How early', <ArrivalLine key="arrival" record={r} />],
            ['Value', money(r.estimated_value, r.estimated_value_currency)],
            ['Capacity', r.capacity_mw != null ? `${Math.round(r.capacity_mw).toLocaleString()} MW` : null],
            ['Floor area', r.square_footage != null ? `${r.square_footage.toLocaleString()} sq ft` : null],
            ['Floors', r.number_of_floors],
            ['Phase', r.current_phase],
            ['Announced', fmtDate(r.announced_date)],
            ['Construction start', fmtDate(r.construction_start_date)],
            ['Est. completion', fmtDate(r.estimated_completion_date)],
            ['Bid date', fmtDate(r.bid_date)],
          ]}
        />
      </Section>

      <Section title="Contact">
        <Facts
          rows={[
            ['Name', r.contact_name],
            ['Title', r.contact_title],
            ['Email', r.contact_email],
            ['Phone', r.contact_phone],
            ['Website', r.company_website ?? r.company_domain],
          ]}
        />
        {/*
          Whether an address was actually confirmed, stated next to it. Leads
          export without verification when the policy allows it, so "we have an
          email" and "we checked this email" have to be tellable apart on the
          record — otherwise an unconfirmed address reads as a confirmed one and
          the bounce is a surprise. `never checked` is distinct from `unverified`
          on purpose: no validator ran at all versus one ran and was not
          satisfied.
        */}
        {r.contact_email || r.contact_phone ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {r.contact_email ? (
              <Badge tone={r.email_verified ? 'success' : 'warning'}>
                {r.email_verified
                  ? `email verified${r.email_validation_source ? ` · ${r.email_validation_source}` : ''}`
                  : r.email_validation_source
                    ? `email unverified · ${r.email_validation_source}`
                    : 'email never checked'}
              </Badge>
            ) : null}
            {r.contact_phone ? (
              <Badge tone={r.phone_verified ? 'success' : 'warning'}>
                {r.phone_verified
                  ? `phone verified${r.phone_validation_source ? ` · ${r.phone_validation_source}` : ''}`
                  : r.phone_validation_source
                    ? `phone unverified · ${r.phone_validation_source}`
                    : 'phone never checked'}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </Section>

      <Section title="Sales intelligence">
        <Facts
          rows={[
            ['ICP fit', r.icp_fit_score != null ? `${r.icp_fit_score}${r.icp_fit_reason ? ` — ${r.icp_fit_reason}` : ''}` : null],
            ['Timing', r.evercam_timing ? titleize(r.evercam_timing) : null],
            ['Trigger', r.trigger_event],
            ['Opening hook', r.opening_hook],
            ['Value angle', r.value_angle ? titleize(r.value_angle) : null],
            ['Pain point', r.pain_point],
          ]}
        />
      </Section>

      <Section title="Record">
        <Facts
          rows={[
            // Handover, first. Once a lead has gone to Apollo it is archived out
            // of the working list, and somebody looking at it needs to know that
            // before they read anything else — otherwise they work a lead that
            // has already been handed over.
            [
              'Exported',
              r.apollo_exported_at ? (
                <span key="exp" className="flex flex-wrap items-center gap-2">
                  <Badge tone="success">archived — sent to Apollo</Badge>
                  <span className="text-muted">
                    {fmtDate(r.apollo_exported_at)}
                    {r.apollo_export_status ? ` · ${r.apollo_export_status}` : ''}
                  </span>
                </span>
              ) : r.apollo_export_status === 'failed' ? (
                <span key="expf" className="flex flex-wrap items-center gap-2">
                  <Badge tone="danger">export failed</Badge>
                  <span className="text-muted">{r.apollo_export_error ?? 'no reason recorded'}</span>
                </span>
              ) : null,
            ],
            ['Created', fmtDate(r.created_at)],
            ['Updated', fmtDate(r.updated_at)],
            ['Processing', r.processing_status ? titleize(r.processing_status) : null],
          ]}
        />
      </Section>

      <div className="border-border-base flex flex-wrap gap-3 border-t pt-4 text-xs">
        {r.project_url ? (
          <a
            href={r.project_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand underline underline-offset-2"
          >
            Open at source ↗
          </a>
        ) : null}
        {r.account_key ? (
          <Link href={`/accounts/${encodeURIComponent(r.account_key)}`} className="text-brand underline underline-offset-2">
            View account →
          </Link>
        ) : null}
      </div>
    </div>
  );
}
