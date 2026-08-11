/**
 * Leads as a spreadsheet — what a person was given, and when it was sent.
 *
 * This started as a throwaway script for one question ("what went to Jose on the
 * 10th"), which is exactly the kind of question that gets asked again next week
 * about somebody else. The answer lives in 133 columns of canonical_projects, so
 * asking it without a tool means writing SQL, and the person who wants the answer
 * is not the person who writes SQL.
 *
 * The row mapping is pure and separate from the fetch so the column choice can be
 * tested without a database, and so the same shape can back a CSV or an on-screen
 * table later without the columns drifting between them.
 */

import { getServiceSupabase } from '@/lib/supabase/server';

/**
 * Forty columns chosen from the hundred and thirty-three.
 *
 * The test is whether a reader can make the call from this row and then prove
 * when it was handed over: project and company, where it is and what it is worth,
 * the priority that justified spending on it, the contact and whether the contact
 * was verified, the four sales angles, and the assignment and export stamps.
 *
 * Everything omitted is either internal bookkeeping (retry counters, provenance
 * blobs, raw source payloads) or a duplicate of a column already here in a less
 * readable form.
 */
export interface ReportRow {
  Project: string;
  Company: string;
  Vertical: string;
  BU: string;
  Phase: string;
  Type: string;
  City: string;
  State: string;
  Country: string;
  Value: string;
  'Capacity MW': number | string;
  Completion: string;
  Band: string;
  Score: number | string;
  ICP: string;
  'ICP fit': number | string;
  Contact: string;
  Title: string;
  Email: string;
  'Email verified': string;
  Phone: string;
  'Phone verified': string;
  'Extra contacts': number;
  LinkedIn: string;
  'Opening hook': string;
  'Value angle': string;
  'Pain point': string;
  Trigger: string;
  Timing: string;
  Route: string;
  Stage: string;
  Status: string;
  'Assigned at (UTC)': string;
  'Exported at (UTC)': string;
  'Export status': string;
  'Apollo account': string;
  'Apollo contact id': string;
  Source: string;
  Ref: string;
  'Project URL': string;
}

const text = (v: unknown): string => (v == null ? '' : String(v));
const day = (v: unknown): string => (v ? String(v).slice(0, 10) : '');

/**
 * "2026-08-10 06:51" — a timestamp somebody can read and sort.
 *
 * UTC and labelled as such in the column header. Converting to a local zone would
 * make the sheet disagree with the database and with anybody in another office,
 * and this roster spans several.
 */
const stamp = (v: unknown): string => (v ? String(v).replace('T', ' ').slice(0, 16) : '');

/** "yes" / "no" / "" — blank means never checked, which is not the same as "no". */
const flag = (v: unknown): string => (v === true ? 'yes' : v === false ? 'no' : '');

const money = (v: unknown, currency: unknown): string =>
  v == null ? '' : `${text(currency) || 'USD'} ${Number(v).toLocaleString()}`;

/** One database row as one spreadsheet row. Pure. */
export function toReportRow(r: Record<string, unknown>): ReportRow {
  return {
    Project: text(r.canonical_name),
    Company: text(r.company_name_raw),
    Vertical: text(r.vertical),
    BU: text(r.bu),
    Phase: text(r.current_phase),
    Type: text(r.project_type),
    City: text(r.city),
    State: text(r.state_province),
    Country: text(r.country),
    Value: money(r.estimated_value, r.estimated_value_currency),
    'Capacity MW': (r.capacity_mw as number) ?? '',
    Completion: day(r.estimated_completion_date),
    Band: text(r.priority_band),
    Score: (r.priority_score as number) ?? '',
    ICP: text(r.icp_code),
    'ICP fit': (r.icp_fit_score as number) ?? '',
    Contact: text(r.contact_name),
    Title: text(r.contact_title),
    Email: text(r.contact_email),
    'Email verified': flag(r.email_verified),
    Phone: text(r.contact_phone),
    'Phone verified': flag(r.phone_verified),
    // The committee is where the people usually are, so its size belongs on the
    // row even though the members themselves would not fit.
    'Extra contacts': Array.isArray(r.additional_contacts) ? r.additional_contacts.length : 0,
    LinkedIn: text(r.contact_linkedin_url),
    'Opening hook': text(r.opening_hook),
    'Value angle': text(r.value_angle),
    'Pain point': text(r.pain_point),
    Trigger: text(r.trigger_event),
    Timing: text(r.evercam_timing),
    Route: text(r.route),
    Stage: text(r.stage),
    Status: text(r.status),
    'Assigned at (UTC)': stamp(r.owner_assigned_at),
    'Exported at (UTC)': stamp(r.apollo_exported_at),
    'Export status': text(r.apollo_export_status),
    'Apollo account': text(r.apollo_account_name),
    'Apollo contact id': text(r.apollo_contact_id),
    Source: text(r.source_key),
    Ref: text(r.ref_code),
    'Project URL': text(r.project_url),
  };
}

export interface ReportQuery {
  /** Roster id. Omitted means every owner. */
  assigneeId?: string;
  /** Inclusive UTC day, `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive UTC day — the query adds a day so the whole day is covered. */
  to?: string;
  /** Only leads Apollo has actually received. */
  exportedOnly?: boolean;
}

/** A sheet cannot be unbounded; a browser will not open a million rows either. */
export const REPORT_ROW_CAP = 5000;

/**
 * Turn an inclusive end DAY into the exclusive timestamp a range needs.
 *
 * Asking for the 10th and getting nothing after 00:00 on the 10th is the classic
 * off-by-a-day in every report like this, so the boundary is computed once, here,
 * and tested.
 */
export function exclusiveEnd(to: string): string {
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export interface ReportResult {
  rows: ReportRow[];
  /** True when the cap stopped the read — the sheet is a prefix, not the answer. */
  truncated: boolean;
}

/**
 * The matching leads, newest assignment first.
 *
 * Keyset paged on id rather than `.range()`, because an offset walk over a
 * filtered set repeats and skips rows, and a report that quietly duplicates a
 * lead is worse than one that is slow.
 */
export async function fetchReportRows(query: ReportQuery): Promise<ReportResult> {
  const supabase = getServiceSupabase();
  const rows: ReportRow[] = [];
  let after = '';

  for (let page = 0; rows.length < REPORT_ROW_CAP; page += 1) {
    let q = supabase.from('canonical_projects').select('*').order('id', { ascending: true }).limit(1000);

    if (query.assigneeId) q = q.eq('assignee_id', query.assigneeId);
    if (query.from) q = q.gte('owner_assigned_at', `${query.from}T00:00:00Z`);
    if (query.to) q = q.lt('owner_assigned_at', exclusiveEnd(query.to));
    if (query.exportedOnly) q = q.not('apollo_exported_at', 'is', null);
    /*
      A date range on owner_assigned_at implies the lead has an owner. Stated
      explicitly so the filter does not depend on nulls sorting out of a `gte`,
      which is true in PostgREST but is not the sort of thing to rely on quietly.
    */
    if (query.from || query.to || query.assigneeId) q = q.not('assignee_id', 'is', null);
    if (after) q = q.gt('id', after);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data?.length) break;

    for (const r of data as Record<string, unknown>[]) rows.push(toReportRow(r));
    after = String((data[data.length - 1] as { id: string }).id);
    if (data.length < 1000) break;
  }

  return { rows: rows.slice(0, REPORT_ROW_CAP), truncated: rows.length > REPORT_ROW_CAP };
}

/** The Summary sheet: the question this file answers, and the shape of the answer. */
export function buildSummary(
  rows: ReportRow[],
  meta: { owner: string; from?: string; to?: string; truncated: boolean }
): (string | number)[][] {
  const exported = rows.filter((r) => r['Exported at (UTC)']).length;
  const tally = (pick: (r: ReportRow) => string) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = pick(r) || 'none';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  return [
    ['Owner', meta.owner],
    ['Assigned between (UTC)', meta.from && meta.to ? `${meta.from} to ${meta.to}` : (meta.from ?? meta.to ?? 'any date')],
    ['Leads', rows.length],
    ['Exported to Apollo', exported],
    ['Not yet exported', rows.length - exported],
    ['With an email', rows.filter((r) => r.Email).length],
    ['With a phone', rows.filter((r) => r.Phone).length],
    [''],
    ['Priority band', 'Leads'],
    ...tally((r) => r.Band),
    [''],
    ['Vertical', 'Leads'],
    ...tally((r) => r.Vertical),
    [''],
    // Said on the sheet, not just in a header nobody reads, because a truncated
    // report that looks complete is the failure this codebase keeps finding.
    ...(meta.truncated
      ? [['WARNING', `Capped at ${REPORT_ROW_CAP.toLocaleString()} rows — this is a partial answer. Narrow the dates.`]]
      : []),
    ['Note', 'Timestamps are UTC.'],
  ];
}
