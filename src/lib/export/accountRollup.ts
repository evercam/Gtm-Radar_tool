import 'server-only';
import { partyLabel } from '@/lib/semantics';

/**
 * Every live project a company has, on the company's Apollo account.
 *
 * A BDR works outward: what is being built, then who is building it, then who to
 * call. The contact brief answers the last two, but it is per-person and per-
 * project — so somebody looking at Cleveland-Cliffs sees one mine on one contact
 * and has no idea there are four more. Cleveland-Cliffs owns five records here,
 * NextEra 270.
 *
 * This is deliberately NOT written into Apollo's own account fields. All six of
 * those (`Qualify Account`, `evercam_us_project_signal`, the `Prerequisite:` pair,
 * `Industry Fit`, `evercam_competitor_signal`) are `is_ai_field: true` with
 * `dynamic_field_type: 'prompt_execution'` — Apollo generates them by running
 * prompts, and three are flagged read-only-mapped. Writing there would overwrite a
 * real research workflow and then be overwritten back. It is also why the export's
 * writes to them were silently discarded: not a bug, a boundary.
 */

/** The subset of a canonical_projects row this needs. */
export interface AccountProjectRow {
  canonical_name?: string | null;
  project_type?: string | null;
  current_phase?: string | null;
  estimated_value?: number | null;
  estimated_value_currency?: string | null;
  priority_band?: string | null;
  priority_score?: number | null;
  city?: string | null;
  state_province?: string | null;
  country?: string | null;
  trigger_event?: string | null;
  construction_start_date?: string | null;
  estimated_completion_date?: string | null;
  contact_name?: string | null;
  additional_contacts?: unknown;
  apollo_exported_at?: string | null;
  icp_code?: string | null;
}

/** Apollo's textarea ceiling. A 270-project company can genuinely reach it. */
export const ACCOUNT_ROLLUP_MAX = 20_000;

const has = (v: unknown) => v !== null && v !== undefined && v !== '' && !(typeof v === 'string' && !v.trim());

function money(v: number, currency?: string | null): string {
  const sym = !currency || currency === 'USD' ? '$' : `${currency} `;
  if (v >= 1e9) return `${sym}${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${sym}${Math.round(v / 1e6)}M`;
  return `${sym}${v.toLocaleString()}`;
}

const day = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10);
};

/** P1 beats P2. Unscored sorts last rather than first. */
const bandRank = (b?: string | null) => (b && /^P(\d)$/.test(b) ? Number(b[1]) : 99);

/** One project, as the lines it occupies. Built as a block so truncation can cut
 *  between projects instead of mid-sentence. */
function projectBlock(r: AccountProjectRow, n: number): string[] {
  const out = ['', `${n}. ${r.canonical_name}`];

  const meta = [
    [r.project_type, r.current_phase].filter(has).join(' · ') || null,
    has(r.estimated_value) ? money(r.estimated_value as number, r.estimated_value_currency) : null,
    r.priority_band ? `priority ${r.priority_band}` : null,
  ]
    .filter(Boolean)
    .join(' — ');
  if (meta) out.push(`   ${meta}`);

  const place = [r.city, r.state_province, r.country].filter(has).join(', ');
  if (place) out.push(`   ${place}`);

  const dates = [
    has(r.construction_start_date) ? `starts ${day(String(r.construction_start_date))}` : null,
    has(r.estimated_completion_date) ? `completes ${day(String(r.estimated_completion_date))}` : null,
  ].filter(Boolean);
  if (dates.length) out.push(`   ${dates.join(' · ')}`);

  if (has(r.trigger_event)) out.push(`   Why now: ${r.trigger_event}`);

  // Whether there is anybody to call, so a rep knows before going looking.
  const committee = (Array.isArray(r.additional_contacts) ? r.additional_contacts.length : 0) + (has(r.contact_name) ? 1 : 0);
  out.push(
    `   ${
      r.apollo_exported_at
        ? `contacted ${day(String(r.apollo_exported_at))}`
        : committee
          ? `${committee} contact${committee === 1 ? '' : 's'} on file, not yet contacted`
          : 'no contact found yet'
    }`
  );
  return out;
}

/**
 * The rollup for one account.
 *
 * Ordered by priority, so the first project a rep reads is the one worth calling
 * about. Already-contacted projects are marked rather than hidden — "we have
 * already reached out about three of these" is what prevents a duplicate first
 * call.
 */
export function renderAccountProjects(company: string, rows: AccountProjectRow[]): string {
  /*
    One entry per project, not one per row.

    The same project is stored many times over: AWS Sunbury holds 9 rows, ACS Fort
    Worth 17, Micron's New York megafab 15. Listing rows would show a BDR the same
    build fifteen times and make the count meaningless. Keyed on a normalised name
    so punctuation and spacing differences collapse; the richest row wins, since
    duplicates are rarely equally complete.
  */
  const key = (n?: string | null) =>
    String(n ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const score = (r: AccountProjectRow) =>
    [r.estimated_value, r.trigger_event, r.current_phase, r.construction_start_date, r.apollo_exported_at].filter(has)
      .length;
  const richest = new Map<string, AccountProjectRow>();
  for (const r of rows) {
    if (!has(r.canonical_name)) continue;
    const k = key(r.canonical_name);
    const prev = richest.get(k);
    if (!prev || score(r) > score(prev)) richest.set(k, r);
  }
  const live = [...richest.values()];
  if (live.length === 0) return '';

  const sorted = [...live].sort(
    (a, b) => bandRank(a.priority_band) - bandRank(b.priority_band) || (b.priority_score ?? 0) - (a.priority_score ?? 0)
  );

  const valued = sorted.filter((r) => typeof r.estimated_value === 'number' && (r.estimated_value ?? 0) > 0);
  const combined = valued.reduce((sum, r) => sum + (r.estimated_value as number), 0);
  const best = sorted.map((r) => r.priority_band).find((b) => bandRank(b) < 99);
  const reached = sorted.filter((r) => r.apollo_exported_at).length;

  const head = [`${company.toUpperCase()} — ${sorted.length} project${sorted.length === 1 ? '' : 's'} on file`];
  /*
    Owner or contractor, stated once at the top.

    Taken from whichever record carries an icp_code — a company plays the same
    role across its projects, so the first one that knows is enough.
  */
  const party = sorted.map((r) => partyLabel(r.icp_code)).find(Boolean);
  if (party) head.push(party);
  const summary = [
    // Only claim a combined value when enough of them carry one to mean anything.
    combined > 0 ? `${money(combined)} combined across ${valued.length} of ${sorted.length}` : null,
    best ? `highest priority ${best}` : null,
    reached ? `${reached} already contacted` : null,
  ].filter(Boolean);
  if (summary.length) head.push(summary.join(' · '));

  const blocks = sorted.map((r, i) => projectBlock(r, i + 1));

  // Fit as many whole projects as the field allows, and say how many were left.
  const kept: string[] = [...head];
  let used = kept.join('\n').length;
  let shown = 0;
  const NOTE_BUDGET = 90;
  for (const block of blocks) {
    const cost = block.join('\n').length + 1;
    if (used + cost > ACCOUNT_ROLLUP_MAX - NOTE_BUDGET) break;
    kept.push(...block);
    used += cost;
    shown += 1;
  }
  if (shown < blocks.length) {
    const left = blocks.length - shown;
    kept.push('', `[${left} more project${left === 1 ? '' : 's'} not shown — the full list is in the tool]`);
  }
  return kept.join('\n');
}
