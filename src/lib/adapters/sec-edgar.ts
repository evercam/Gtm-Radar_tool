import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import type { CriticalField } from '@/lib/supabase/types';

/**
 * SEC EDGAR Full-Text Search adapter (ICP: mission_critical_owner) — earliest
 * PRIVATE-sector capex signal: public-company 8-K/10-K filings that mention
 * building a new facility ("data center", "gigafactory", "semiconductor fab",
 * etc.). KEYLESS — SEC only requires a descriptive User-Agent.
 *
 * Endpoint/shape LIVE-VERIFIED on 2026-07-24:
 *   - GET https://efts.sec.gov/LATEST/search-index
 *   - Params: q (full-text query), forms (CSV form types), startdt/enddt
 *     (YYYY-MM-DD), from (offset).
 *   - Response: { hits: { total: {value}, hits: [ { _id, _source } ] } }
 *   - _source fields: ciks[], display_names[] ("NAME  (TICKER)  (CIK ...)"),
 *     file_date, period_ending, root_forms[], form, file_type,
 *     file_description, biz_states[], biz_locations[] ("City, ST"),
 *     sics[] (industry), adsh (accession), items[].
 *   - _id: "{adsh}:{filename}" — used to build the filing document URL.
 *
 * This is deliberately a LOW-completeness (Tier D) source: the FTS index gives
 * filer name, location, and date — NOT project value, contact, or square
 * footage (those live in the filing text). The completeness score reflects
 * that honestly; EDGAR hits are early signals that require enrichment.
 */

/**
 * What an 8-K item code actually means, for the ones that matter here.
 *
 * `items` is returned on 100% of 8-K hits and was being passed through raw: the
 * description read "Items 1.01, 2.02, 7.01", which tells a seller nothing. The codes
 * are the only thing in this index that says what a filing IS, and they separate a
 * facility announcement from a quarterly earnings release that merely mentions data
 * centres. Measured 2026-08-18 over 600 stored records:
 *
 *   no items at all (10-K, 10-Q)                    50%
 *   PURE earnings — 2.02 and nothing substantive      9%   noise
 *   substantive (1.01 / 2.01 / 8.01 / 7.01)          39%
 *   material definitive agreement (1.01)             11%   the contract signal
 *
 * Only the codes worth naming are here. An unmapped code keeps its number rather
 * than being dropped, because a code we have not classified is still evidence.
 */
const ITEM_LABELS: Record<string, string> = {
  '1.01': 'material definitive agreement',
  '1.02': 'agreement terminated',
  '2.01': 'acquisition or disposition completed',
  '2.02': 'earnings release',
  '2.03': 'new debt obligation',
  '3.02': 'unregistered equity sale',
  '5.02': 'director or officer change',
  '7.01': 'Reg FD disclosure',
  '8.01': 'other events',
  '9.01': 'financial statements and exhibits',
};

/**
 * Items that suggest a filing is about a DEAL or an EVENT rather than a results
 * announcement. A filing carrying none of these, but carrying 2.02, is a quarterly
 * earnings release that matched the full-text query because earnings discuss data
 * centres — real, and not a project.
 */
const SUBSTANTIVE_ITEMS = new Set(['1.01', '2.01', '7.01', '8.01']);

const DEFAULT_BASE_URL = 'https://efts.sec.gov/LATEST/search-index';
const USER_AGENT = 'Evercam Source Hub research@evercam.io';
const DEFAULT_QUERY = '"new facility" OR "data center" OR gigafactory OR "manufacturing plant"';
const PAGE = 100; // EDGAR FTS caps at 100 hits/page

interface EdgarSource {
  ciks?: string[];
  display_names?: string[];
  file_date?: string;
  period_ending?: string;
  root_forms?: string[];
  form?: string;
  file_type?: string;
  file_description?: string;
  biz_states?: string[];
  biz_locations?: string[];
  sics?: string[];
  adsh?: string;
  items?: string[];
}
interface EdgarHit {
  _id?: string;
  _source?: EdgarSource;
}
interface EdgarResponse {
  hits?: { total?: { value?: number }; hits?: EdgarHit[] };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "TECOGEN INC.  (TGEN)  (CIK 0001537435)" -> "TECOGEN INC." */
function cleanCompany(displayName: string | undefined): string | null {
  if (!displayName) return null;
  const cut = displayName.split('  (')[0]?.trim();
  return cut || displayName.trim() || null;
}

/** "North Billerica, MA" -> { city, state } */
function parseLocation(loc: string | undefined): { city: string | null; state: string | null } {
  if (!loc) return { city: null, state: null };
  const idx = loc.lastIndexOf(',');
  if (idx === -1) return { city: loc.trim() || null, state: null };
  return { city: loc.slice(0, idx).trim() || null, state: loc.slice(idx + 1).trim() || null };
}

/** Build the filing document URL from _id + cik. */
function filingUrl(id: string | undefined, cik: string | undefined): string | null {
  if (!id) return null;
  const [adsh, filename] = id.split(':');
  if (!adsh) return null;
  const cikNum = cik ? String(Number(cik)) : null;
  const adshNoDash = adsh.replace(/-/g, '');
  if (cikNum && filename) {
    return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${adshNoDash}/${filename}`;
  }
  return `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(adsh)}`;
}

export const secEdgarAdapter: SourceAdapter = {
  sourceKey: 'sec_edgar',

  // Keyless — always "configured".
  async isConfigured(): Promise<boolean> {
    return true;
  },

  async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
    const baseUrl = (params.credentials?.baseUrl?.trim() || process.env.SEC_EDGAR_BASE_URL || DEFAULT_BASE_URL).replace(
      /\/$/,
      ''
    );
    const pageSize = params.dryRun ? Math.min(params.pageSize ?? 5, PAGE) : (params.pageSize ?? PAGE);
    /**
     * The run's budget, separate from the page size.
     *
     * These were one number, which capped every scheduled pull at whatever the
     * page size was — the route passed 50, the loop stopped at 50, the result was
     * sliced to 50, and `max_records_per_run` (500) was never applied. Absent, it
     * still means one page, so an un-updated caller behaves exactly as before.
     */
    const maxRecords = params.dryRun ? pageSize : (params.maxRecords ?? pageSize);

    // Build the full-text query from keyword + sector term presets.
    const terms = [params.keyword?.trim(), ...(params.sectors ?? []).map((s) => `"${s}"`)].filter(Boolean);
    const q = terms.length ? terms.join(' OR ') : DEFAULT_QUERY;

    const now = new Date();
    const from = params.since ?? new Date(now.getTime() - 365 * 86_400_000);
    const to = params.until ?? now;

    const results: EdgarHit[] = [];
    let offset = ((params.page ?? 1) - 1) * PAGE;
    // Enough pages to reach the budget, with a hard ceiling so a misconfigured
    // budget cannot walk a vendor’s whole index.
    const maxPages = params.dryRun ? 1 : Math.min(40, Math.max(1, Math.ceil(maxRecords / Math.max(1, pageSize)) + 2));

    for (let i = 0; i < maxPages && results.length < maxRecords; i++) {
      const qp = new URLSearchParams({ q, startdt: ymd(from), enddt: ymd(to), from: String(offset) });
      if (params.forms?.length) qp.set('forms', params.forms.join(','));

      const res = await fetchWithRetry(
        `${baseUrl}?${qp.toString()}`,
        { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
        { timeoutMs: 20_000 }
      );
      if (!res.ok) {
        throw new Error(`SEC EDGAR request failed: HTTP ${res.status} ${res.statusText}`);
      }

      let body: EdgarResponse;
      try {
        body = (await res.json()) as EdgarResponse;
      } catch {
        throw new AdapterShapeError('SEC EDGAR response was not valid JSON.');
      }
      const hits = body.hits?.hits;
      if (!Array.isArray(hits)) {
        throw new AdapterShapeError('SEC EDGAR response did not contain hits.hits[].');
      }

      results.push(...hits);
      if (params.dryRun || hits.length < PAGE) break;
      offset += hits.length;
    }

    // regions -> client-side match on biz_states / biz_locations.
    let filtered = results;
    if (params.regions?.length) {
      const wanted = params.regions.map((r) => r.toLowerCase());
      filtered = filtered.filter((h) => {
        const hay = [...(h._source?.biz_states ?? []), ...(h._source?.biz_locations ?? [])].join(' ').toLowerCase();
        return wanted.some((r) => hay.includes(r));
      });
    }

    return filtered.slice(0, maxRecords) as unknown as RawProjectRecord[];
  },

  normalize(raw: RawProjectRecord): CanonicalProjectInsert {
    const hit = raw as unknown as EdgarHit;
    const s = hit._source ?? {};
    const extId = String(hit._id ?? s.adsh ?? '');

    const company = cleanCompany(s.display_names?.[0]);
    const form = s.root_forms?.[0] ?? s.form ?? null;
    const { city, state } = parseLocation(s.biz_locations?.[0]);
    const stateFallback = state ?? s.biz_states?.[0] ?? null;
    const cik = s.ciks?.[0];

    const projectName = company ? `${company} — ${form ?? 'SEC'} facility/capex disclosure` : `SEC filing ${extId}`;

    /*
      The item codes, read rather than passed through.

      `hasAgreement` is the filing saying a material definitive agreement exists —
      for a facility disclosure that is usually the construction or lease contract,
      and it is the strongest signal this index gives. `earningsOnly` is the
      opposite: a 2.02 with nothing substantive alongside it, which is a quarterly
      results release that matched the query because results talk about data centres.
      Measured over 600 stored records: 11% and 9% respectively.

      Neither is used to DISCARD anything. A 10-K has no items at all (50% of the
      corpus) and is still a real capex disclosure, and an earnings release can carry
      a genuine announcement. They change what the record SAYS, not whether it exists.
    */
    const items = (s.items ?? []).filter((c): c is string => typeof c === 'string');
    const itemSet = new Set(items);
    const hasAgreement = itemSet.has('1.01');
    const earningsOnly = itemSet.has('2.02') && !items.some((c) => SUBSTANTIVE_ITEMS.has(c));

    // Honest completeness: FTS gives name, company, location, timeline only —
    // NOT value, building type, contact, sqft, funding, etc.
    const presentFields: Partial<Record<CriticalField, boolean>> = {
      project_name: isPresent(projectName),
      project_value: false,
      project_location: isPresent(city) || isPresent(stateFallback),
      project_timeline: isPresent(s.file_date),
      building_type: false,
      company_name: isPresent(company),
      company_contact: false,
      project_phase: false,
      square_footage: false,
      funding_source: false,
      company_website: false,
      company_phone: false,
    };

    const completeness = computeCompleteness(presentFields);

    return {
      canonical_name: projectName,
      source_key: 'sec_edgar',
      source_unique_id: extId,
      icp_code: 'mission_critical_owner',
      record_type: 'filing',
      // Mission-critical capex signals (data centers, gigafactories, fabs) — the
      // complex, high-stakes projects the Export/Major Projects business targets.
      bu: 'export',
      // SIC is the FILER's industry (not a building type) — keep it as project_type context only.
      project_type: s.sics?.[0] ? `SIC ${s.sics[0]}` : null,
      building_type: null,
      description:
        [
          s.form,
          s.file_description,
          // Named, not numbered. "Items 1.01, 2.02" is a code a seller has to look
          // up; "material definitive agreement; earnings release" is the reason to
          // read the filing or skip it.
          items.length ? items.map((c) => ITEM_LABELS[c] ?? `item ${c}`).join('; ') : null,
          earningsOnly
            ? 'Likely a quarterly earnings release rather than a project announcement — it matched the search because results discuss facilities.'
            : null,
        ]
          .filter(Boolean)
          .join(' — ') || null,
      address_line1: null,
      city,
      state_province: stateFallback,
      country: 'US',
      country_code: 'US',
      announced_date: normalizeDate(s.file_date),
      construction_start_date: null,
      estimated_completion_date: null,
      bid_date: null,
      project_url: filingUrl(hit._id, cik),
      /*
        A PHASE, rather than null on all 4,047 records.

        With no phase, `arrivalFor` fell through to the record-type default for
        'filing' — an arbitrary weight that happens to land on `unconfirmed`. The
        verdict was therefore right by accident and untunable: an admin editing the
        phase table could not move it, because it was not reading the table at all.

        A filing that mentions building a facility IS an announcement, so it says so.
        'Announcement' is a phase the table already matches ("announced only", weight
        0.3), which keeps the same practical verdict while making it explicit and
        editable. A material definitive agreement is further along — the contract for
        the thing exists — so it maps to 'Awarded'.
      */
      current_phase: hasAgreement ? 'Awarded' : 'Announcement',
      estimated_value: null,
      estimated_value_currency: null,
      company_name_raw: company,
      contact_name: null,
      contact_title: null,
      contact_email: null,
      contact_phone: null,
      source_completeness_tier: completeness.tier,
      source_completeness_score: completeness.score,
      fields_populated: completeness.fieldsPopulated,
      fields_missing: completeness.fieldsMissing,
      population_percentage: completeness.populationPercentage,
      processing_status: 'normalized',
      raw_data: raw,
    };
  },
};

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
