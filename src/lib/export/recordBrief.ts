import { partyLabel } from '@/lib/semantics';

/**
 * The whole record, rendered for somebody about to make a call.
 *
 * The export sent seven fields. The tool holds 133 columns, 95 of which carry
 * data, and the omissions were not marginal: `description` is populated on 100%
 * of export-shaped records, `priority_score`/`band`/`reasons` on 100%,
 * `project_url` — the link to the source that surfaced the lead — on 58%,
 * `capacity_mw` on 75%, `building_type` on 78%, `committee_coverage` on 97%.
 * None of it reached Apollo. A rep opening a contact saw a title, a one-line
 * summary and a script, and had to come back here for everything else.
 *
 * Rendered as ONE text block rather than thirty custom fields, because:
 *
 *   - It is read, not filtered. A rep reads a brief top to bottom before
 *     dialling; nobody sorts an Apollo list by capacity_mw. The handful of
 *     things worth filtering on stay separate structured fields.
 *   - Apollo textarea fields hold 20,000 characters, so the whole record fits
 *     with room to spare — the largest real brief measured here is well under
 *     3,000.
 *   - Thirty custom fields is thirty things to provision, map, and keep in step
 *     with a workspace somebody else also edits. One block cannot drift.
 *
 * Every section is omitted when it has nothing in it. A brief padded with
 * "Value: unknown / Start: unknown" trains the reader to skip it, and the
 * fields here are genuinely sparse — `estimated_value` lands on 23%.
 */

/** The subset of a canonical_projects row this renders. All optional. */
export interface BriefRecord {
  canonical_name?: string | null;
  ref_code?: string | null;
  description?: string | null;
  project_type?: string | null;
  building_type?: string | null;
  current_phase?: string | null;
  project_url?: string | null;
  estimated_value?: number | null;
  estimated_value_currency?: string | null;
  square_footage?: number | null;
  number_of_floors?: number | null;
  capacity_mw?: number | null;
  technology_type?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state_province?: string | null;
  country?: string | null;
  is_remote_location?: boolean | null;
  is_access_constrained?: boolean | null;
  announced_date?: string | null;
  construction_start_date?: string | null;
  estimated_completion_date?: string | null;
  bid_date?: string | null;
  company_name_raw?: string | null;
  /** Encodes whether this company owns the project or builds it. */
  icp_code?: string | null;
  company_website?: string | null;
  apollo_account_name?: string | null;
  icp_fit_score?: number | null;
  icp_fit_reason?: string | null;
  evercam_timing?: string | null;
  trigger_event?: string | null;
  opening_hook?: string | null;
  value_angle?: string | null;
  pain_point?: string | null;
  call_prep_summary?: string | null;
  priority_score?: number | null;
  priority_band?: string | null;
  priority_reasons?: unknown;
  committee_coverage?: unknown;
  contact_name?: string | null;
  contact_title?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  contact_linkedin_url?: string | null;
  contact_role?: string | null;
  email_verified?: boolean | null;
  phone_verified?: boolean | null;
  additional_contacts?: unknown;
  source_key?: string | null;
  vertical?: string | null;
  bu?: string | null;
  enriched_at?: string | null;
}

/** Apollo's textarea ceiling. Briefs are nowhere near it, but a cap that is never
 *  hit is still the difference between a long brief and a rejected contact. */
export const BRIEF_MAX_CHARS = 20_000;

const has = (v: unknown): boolean =>
  v !== null &&
  v !== undefined &&
  v !== '' &&
  !(typeof v === 'string' && v.trim() === '') &&
  !(Array.isArray(v) && v.length === 0);

/** "$1.5B", "$450M", "$2,300,000" — the scale a reader compares, not the digits. */
function money(v: number, currency?: string | null): string {
  const sym = !currency || currency === 'USD' ? '$' : `${currency} `;
  if (v >= 1e9) return `${sym}${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${sym}${Math.round(v / 1e6)}M`;
  return `${sym}${v.toLocaleString()}`;
}

/** ISO or timestamp → 2026-08-04. Anything unparseable is passed through. */
function day(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10);
}

/** A label/value line, padded so a column of them reads as a table. */
function row(label: string, value: string): string {
  return `  ${label.padEnd(14)}${value}`;
}

/** priority_reasons and committee_coverage are jsonb and shaped inconsistently. */
function listish(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => has(val))
      .map(([k, val]) => `${k.replace(/_/g, ' ')}: ${typeof val === 'object' ? JSON.stringify(val) : String(val)}`);
  }
  return [];
}

/**
 * `committee_coverage` in a sentence rather than as its jsonb.
 *
 * Rendered generically it came out as
 * `found: {"user":7,...}; missing: [{"need":2,"role":"economic"},...]` — every
 * fact present and none of it readable. What a rep needs from this is one line:
 * how far off the eight-contact standard this lead is, and which roles are
 * missing so they know who to ask for.
 */
function formatCoverage(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const c = v as { total?: unknown; target?: unknown; complete?: unknown; missing?: unknown };

  const total = typeof c.total === 'number' ? c.total : null;
  const target = typeof c.target === 'number' ? c.target : null;
  if (total === null && target === null) return null;

  const missing = Array.isArray(c.missing)
    ? (c.missing as { need?: unknown; role?: unknown }[])
        .filter((m) => m && typeof m.role === 'string')
        .map((m) => `${typeof m.need === 'number' ? `${m.need} ` : ''}${String(m.role).replace(/_/g, ' ')}`)
    : [];

  const head =
    total !== null && target !== null
      ? `Coverage: ${total} of ${target} contacts`
      : `Coverage: ${total ?? target} contacts`;
  if (c.complete === true) return `${head} — complete`;
  return missing.length ? `${head} — still needs ${missing.join(', ')}` : head;
}

interface Person {
  name?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedin_url?: string | null;
}

/**
 * The brief for one record.
 *
 * `forEmail` marks which committee member is the person this contact IS, so a rep
 * reading their own record can see where they sit in the group rather than
 * hunting for their own name.
 */
export function renderRecordBrief(r: BriefRecord, forEmail?: string | null): string {
  const out: string[] = [];

  // ---- Heading: what this is, in one glance -------------------------------
  const title = (r.canonical_name ?? 'Untitled project').toUpperCase();
  out.push(title);
  const sub = [r.project_type, r.current_phase, r.company_name_raw].filter(has);
  if (sub.length) out.push(sub.join(' · '));
  /*
    Which side of the table this company is on.

    `icp_code` has always known — 90% of records carry one — and nothing showed
    it, so an exported contact read as an undifferentiated "company". Calling the
    owner and calling the main contractor are different conversations.
  */
  const party = partyLabel(r.icp_code);
  if (party) out.push(party);

  // ---- Why now: the judgement, first, because it decides whether to read on
  const why: string[] = [];
  if (has(r.icp_fit_score)) why.push(`ICP fit ${r.icp_fit_score}/100${r.icp_fit_reason ? ` — ${r.icp_fit_reason}` : ''}`);
  if (has(r.evercam_timing)) why.push(`Timing: ${String(r.evercam_timing).replace(/_/g, ' ')}`);
  if (has(r.trigger_event)) why.push(`Trigger: ${r.trigger_event}`);
  if (has(r.pain_point)) why.push(`Pain: ${r.pain_point}`);
  if (has(r.opening_hook)) why.push(`Open with: ${r.opening_hook}`);
  if (has(r.value_angle)) why.push(`Angle: ${r.value_angle}`);
  if (why.length) out.push('', 'WHY NOW', ...why.map((l) => `  ${l}`));

  // ---- The project: the facts, as a table --------------------------------
  const facts: string[] = [];
  if (has(r.project_type)) facts.push(row('Type', String(r.project_type)));
  if (has(r.building_type)) facts.push(row('Building', String(r.building_type)));
  if (has(r.current_phase)) facts.push(row('Phase', String(r.current_phase)));
  if (has(r.estimated_value)) facts.push(row('Value', money(r.estimated_value as number, r.estimated_value_currency)));
  if (has(r.capacity_mw)) facts.push(row('Capacity', `${r.capacity_mw} MW`));
  if (has(r.technology_type)) facts.push(row('Technology', String(r.technology_type)));
  if (has(r.square_footage)) facts.push(row('Floor area', `${Number(r.square_footage).toLocaleString()} sq ft`));
  if (has(r.number_of_floors)) facts.push(row('Floors', String(r.number_of_floors)));
  const place = [r.address_line1, r.city, r.state_province, r.country].filter(has).join(', ');
  if (place) facts.push(row('Location', place));
  // Only worth a line when true — "Remote: no" is noise.
  if (r.is_remote_location) facts.push(row('Site', 'remote'));
  if (r.is_access_constrained) facts.push(row('Access', 'constrained'));
  if (facts.length) out.push('', 'THE PROJECT', ...facts);

  // ---- Timing -------------------------------------------------------------
  const dates: string[] = [];
  if (has(r.announced_date)) dates.push(row('Announced', day(String(r.announced_date))));
  if (has(r.construction_start_date)) dates.push(row('Starts', day(String(r.construction_start_date))));
  if (has(r.estimated_completion_date)) dates.push(row('Completes', day(String(r.estimated_completion_date))));
  if (has(r.bid_date)) dates.push(row('Bid date', day(String(r.bid_date))));
  if (dates.length) out.push('', 'TIMING', ...dates);

  // ---- The committee ------------------------------------------------------
  const extra = Array.isArray(r.additional_contacts) ? (r.additional_contacts as Person[]) : [];
  const committee: Person[] = [
    { name: r.contact_name, title: r.contact_title, email: r.contact_email, phone: r.contact_phone, linkedin_url: r.contact_linkedin_url },
    ...extra,
  ].filter((p) => has(p?.name) || has(p?.email));

  if (committee.length) {
    const lines = committee.map((p) => {
      const bits = [p.name, p.title].filter(has).join(' — ');
      const reach = [p.email, p.phone].filter(has).join(' · ');
      // The one being called is marked, so a rep finds themselves immediately.
      const mine = forEmail && p.email && p.email.toLowerCase() === forEmail.toLowerCase() ? ' ← this contact' : '';
      return `  ${bits}${reach ? `\n    ${reach}` : ''}${p.linkedin_url ? `\n    ${p.linkedin_url}` : ''}${mine}`;
    });
    out.push('', `THE COMMITTEE (${committee.length})`, ...lines);
    const cov = formatCoverage(r.committee_coverage);
    if (cov) out.push(`  ${cov}`);
    // Verification travels with the addresses, so an unconfirmed one is never
    // mistaken for a checked one — the same trade the export already makes.
    const flags = [
      r.email_verified === true ? 'email verified' : 'email UNVERIFIED',
      has(r.contact_phone) ? (r.phone_verified === true ? 'phone verified' : 'phone UNVERIFIED') : null,
    ].filter(Boolean);
    if (flags.length) out.push(`  ${flags.join(' · ')}`);
  }

  // ---- Priority: why the tool put this in front of them today -------------
  if (has(r.priority_score) || has(r.priority_band)) {
    const reasons = listish(r.priority_reasons);
    out.push(
      '',
      'PRIORITY',
      row('Score', `${r.priority_score ?? '—'}${r.priority_band ? ` (${r.priority_band})` : ''}`)
    );
    if (reasons.length) for (const x of reasons) out.push(`  • ${x}`);
  }

  // ---- The description, as written by the source --------------------------
  if (has(r.description)) out.push('', 'DESCRIPTION', ...wrap(String(r.description).trim(), 96).map((l) => `  ${l}`));

  // ---- The script ---------------------------------------------------------
  if (has(r.call_prep_summary)) out.push('', 'CALL PREP', ...String(r.call_prep_summary).trim().split('\n').map((l) => `  ${l}`));

  // ---- Provenance: where it came from, so a rep can judge the source ------
  const prov: string[] = [];
  if (has(r.source_key)) prov.push(row('Source', String(r.source_key)));
  if (has(r.project_url)) prov.push(row('Link', String(r.project_url)));
  if (has(r.company_website)) prov.push(row('Company', String(r.company_website)));
  if (has(r.vertical)) prov.push(row('Vertical', String(r.vertical)));
  if (has(r.bu)) prov.push(row('BU', String(r.bu)));
  if (has(r.ref_code)) prov.push(row('Ref', String(r.ref_code)));
  if (has(r.enriched_at)) prov.push(row('Enriched', day(String(r.enriched_at))));
  if (prov.length) out.push('', 'PROVENANCE', ...prov);

  const text = out.join('\n');
  if (text.length <= BRIEF_MAX_CHARS) return text;
  // Truncation says so. A brief that stops mid-sentence with no marker reads as
  // missing data rather than a limit.
  const note = '\n\n[brief truncated at Apollo’s field limit]';
  return text.slice(0, BRIEF_MAX_CHARS - note.length) + note;
}

/** Soft-wrap prose so a long description does not render as one endless line. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\n+/)) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line.length) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}
