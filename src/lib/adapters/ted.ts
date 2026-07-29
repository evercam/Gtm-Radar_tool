import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import type { CriticalField } from '@/lib/supabase/types';

/**
 * TED — Tenders Electronic Daily (EU public procurement) adapter
 * (ICP: tier1_gc). KEYLESS. Primary vehicle for IRELAND coverage (and the
 * wider EU) via `place-of-performance` country filtering.
 *
 * Verified live 2026-07-24:
 *   - POST https://api.ted.europa.eu/v3/notices/search
 *   - Body: { query (expert syntax), fields[], limit, page }
 *   - Response: { notices: [ {...} ], totalNoticeCount }
 *   - Notice fields are MULTILINGUAL maps, e.g.
 *     notice-title: { eng: ["..."] }, buyer-name: { eng: ["..."] };
 *     place-of-performance: ["IRL"], contract-nature: ["works"],
 *     publication-date: "2016-07-23+02:00", total-value, links.
 */

const ENDPOINT = 'https://api.ted.europa.eu/v3/notices/search';
/** Documented maximum notices per page. */
const TED_MAX_PAGE = 250;
/**
 * How far back to look when nobody says. Kept tight because TED answers
 * oldest-first and cannot be told otherwise: a wide window buries this month's
 * notices behind last year's.
 */
const TED_DEFAULT_WINDOW_DAYS = 30;
const FIELDS = [
  'publication-number',
  'notice-title',
  'buyer-name',
  'buyer-email',
  'organisation-tel-buyer',
  'place-of-performance',
  'total-value',
  'publication-date',
  'contract-nature',
];

// Region chip label -> ISO-3 country code TED expects in place-of-performance.
const COUNTRY_ISO3: Record<string, string> = {
  ireland: 'IRL',
  'united kingdom': 'GBR',
  uk: 'GBR',
  france: 'FRA',
  germany: 'DEU',
  netherlands: 'NLD',
  spain: 'ESP',
  italy: 'ITA',
  poland: 'POL',
  belgium: 'BEL',
  sweden: 'SWE',
};
// ISO-3 -> ISO-2 for the canonical country_code column.
const ISO3_TO_ISO2: Record<string, string> = {
  IRL: 'IE',
  GBR: 'GB',
  FRA: 'FR',
  DEU: 'DE',
  NLD: 'NL',
  ESP: 'ES',
  ITA: 'IT',
  POL: 'PL',
  BEL: 'BE',
  SWE: 'SE',
};

type MultilingualField = Record<string, string[]> | string[] | string | undefined;

interface TedNotice {
  'publication-number'?: string;
  'notice-title'?: MultilingualField;
  'buyer-name'?: MultilingualField;
  'buyer-email'?: string[] | string;
  'organisation-tel-buyer'?: string[] | string;
  'place-of-performance'?: string[];
  'total-value'?: number | { amount?: number; currency?: string } | null;
  'publication-date'?: string;
  'contract-nature'?: string[];
}
interface TedResponse {
  notices?: TedNotice[];
  totalNoticeCount?: number;
}

/** Extract a readable string from a multilingual field (prefer English). */
function ml(field: MultilingualField): string | null {
  if (!field) return null;
  if (typeof field === 'string') return field || null;
  if (Array.isArray(field)) return field[0] ?? null;
  const langs = field as Record<string, string[]>;
  const pick = langs.eng ?? langs.ENG ?? Object.values(langs)[0];
  return Array.isArray(pick) ? (pick[0] ?? null) : null;
}

function tedValue(v: TedNotice['total-value']): { amount: number | null; currency: string | null } {
  if (v == null) return { amount: null, currency: null };
  if (typeof v === 'number') return { amount: v, currency: 'EUR' };
  return { amount: typeof v.amount === 'number' ? v.amount : null, currency: v.currency ?? 'EUR' };
}

function regionsToCountries(regions: string[] | undefined): string[] {
  if (!regions?.length) return ['IRL']; // default to Ireland
  const codes = regions.map((r) => COUNTRY_ISO3[r.toLowerCase()]).filter(Boolean);
  return codes.length ? Array.from(new Set(codes)) : ['IRL'];
}

export const tedAdapter: SourceAdapter = {
  sourceKey: 'ted',

  async isConfigured(): Promise<boolean> {
    return true; // keyless
  },

  async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
    // TED caps a page at 250 (documented). Asking for 100 cost the same
    // request for 40% of the notices.
    const pageSize = params.dryRun ? Math.min(params.pageSize ?? 5, 50) : (params.pageSize ?? 250);
    const countries = regionsToCountries(params.regions);

    /**
     * TED has no default window and returns OLDEST FIRST within whatever it is
     * given — with no date clause it answers from 2016, and it rejects any
     * sort parameter. So an unbounded call is not "everything, newest first",
     * it is "the oldest notices on the platform". A scheduled query carries no
     * dates by design, which would have made every scheduled TED pull return
     * the same decade-old notices forever.
     */
    const until = params.until ?? new Date();
    const since = params.since ?? new Date(until.getTime() - TED_DEFAULT_WINDOW_DAYS * 86_400_000);

    // TED expert search: dates use YYYYMMDD (verified — dashed dates 400).
    // Keyword is filtered client-side (TED's FT operator is unreliable here).
    const yyyymmdd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const clauses = ['classification-cpv=45*', `(${countries.map((c) => `place-of-performance=${c}`).join(' OR ')})`];
    clauses.push(`publication-date>=${yyyymmdd(since)}`);
    clauses.push(`publication-date<=${yyyymmdd(until)}`);
    const query = clauses.join(' AND ');
    const kw = params.keyword?.trim().toLowerCase() ?? '';

    const notices: TedNotice[] = [];
    let page = params.page ?? 1;
    const maxPages = params.dryRun ? 1 : 10;

    for (let i = 0; i < maxPages && notices.length < pageSize; i++) {
      const res = await fetchWithRetry(
        ENDPOINT,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'Evercam Source Hub research@evercam.io',
          },
          body: JSON.stringify({ query, fields: FIELDS, limit: Math.min(pageSize, TED_MAX_PAGE), page }),
        },
        { timeoutMs: 20_000 }
      );
      if (!res.ok) {
        throw new Error(`TED request failed: HTTP ${res.status} ${res.statusText}`);
      }
      let body: TedResponse;
      try {
        body = (await res.json()) as TedResponse;
      } catch {
        throw new AdapterShapeError('TED response was not valid JSON.');
      }
      const batch = body.notices;
      if (!Array.isArray(batch)) {
        throw new AdapterShapeError('TED response had no notices[].');
      }
      notices.push(...batch);
      if (params.dryRun || batch.length < Math.min(pageSize, 100)) break;
      page += 1;
    }

    // Keyword filtered client-side (dates are handled server-side above).
    const filtered = kw
      ? notices.filter((n) => {
          const title = ml(n['notice-title']) ?? '';
          const buyer = ml(n['buyer-name']) ?? '';
          return `${title} ${buyer}`.toLowerCase().includes(kw);
        })
      : notices;

    return filtered.slice(0, pageSize) as unknown as RawProjectRecord[];
  },

  normalize(raw: RawProjectRecord): CanonicalProjectInsert {
    const n = raw as unknown as TedNotice;
    const extId = String(n['publication-number'] ?? '');
    const title = ml(n['notice-title']) ?? `TED notice ${extId}`;
    const buyer = ml(n['buyer-name']);
    const iso3 = n['place-of-performance']?.[0] ?? null;
    const nature = n['contract-nature']?.[0] ?? null;
    const { amount, currency } = tedValue(n['total-value']);
    const announced = n['publication-date'] ?? null;
    const firstStr = (v: string[] | string | undefined): string | null =>
      Array.isArray(v) ? (v[0] ?? null) : v || null;
    const contactEmail = firstStr(n['buyer-email']);
    const contactPhone = firstStr(n['organisation-tel-buyer']);

    const presentFields: Partial<Record<CriticalField, boolean>> = {
      project_name: isPresent(title),
      project_value: amount != null,
      project_location: isPresent(iso3),
      project_timeline: isPresent(announced),
      building_type: isPresent(nature),
      company_name: isPresent(buyer),
      company_contact: isPresent(contactEmail),
      project_phase: false,
      square_footage: false,
      funding_source: true, // public procurement
      company_website: false,
      company_phone: isPresent(contactPhone),
    };

    const completeness = computeCompleteness(presentFields);
    const iso2 = iso3 ? (ISO3_TO_ISO2[iso3] ?? iso3.slice(0, 2)) : null;

    return {
      canonical_name: title.slice(0, 300),
      source_key: 'ted',
      source_unique_id: extId,
      icp_code: 'tier1_gc',
      record_type: 'tender',
      bu: 'ireland',
      project_type: nature,
      building_type: nature,
      description: null,
      address_line1: null,
      city: null,
      state_province: null,
      country: iso3,
      country_code: iso2,
      announced_date: normalizeDate(announced),
      construction_start_date: null,
      estimated_completion_date: null,
      bid_date: null,
      project_url: extId ? `https://ted.europa.eu/en/notice/${extId}` : null,
      current_phase: null,
      estimated_value: amount,
      estimated_value_currency: amount != null ? currency : null,
      company_name_raw: buyer,
      contact_name: null,
      contact_title: null,
      contact_email: contactEmail,
      contact_phone: contactPhone,
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
  // TED publication-date comes as e.g. "2024-01-04Z" or "2016-07-23+02:00" —
  // the leading YYYY-MM-DD is all we need.
  const m = value.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}
