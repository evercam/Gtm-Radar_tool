import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import type { CriticalField } from '@/lib/supabase/types';

/**
 * USASpending.gov adapter (BU: usa, ICP: tier1_gc) — awarded US federal
 * construction contracts. The record's account is the RECIPIENT (the
 * contractor that won the award — an actionable Tier 1 GC lead); the awarding
 * federal agency is the funder. KEYLESS.
 *
 * Verified live 2026-07-25:
 *   - POST https://api.usaspending.gov/api/v2/search/spending_by_award/
 *   - Body: { filters: { award_type_codes, naics_codes:{require:[...]},
 *     time_period:[{start_date,end_date}], keywords?, award_amounts? },
 *     fields:[...], sort, order, limit(<=100), page }
 *   - Response: { results: [ { "Award ID", "Recipient Name", "Award Amount",
 *     "Place of Performance State Code", "Description", "Awarding Agency Name",
 *     "Start Date", generated_internal_id } ], page_metadata:{hasNext} }
 */

const ENDPOINT = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
// NAICS 4-digit construction subsectors (sector 23); the API rejects bare "23".
const CONSTRUCTION_NAICS = ['2361', '2362', '2371', '2372', '2373', '2379', '2381', '2382', '2383', '2389'];

interface UsaAward {
  'Award ID'?: string;
  'Recipient Name'?: string;
  'Award Amount'?: number | string;
  'Place of Performance State Code'?: string;
  Description?: string;
  'Awarding Agency Name'?: string;
  'Start Date'?: string;
  generated_internal_id?: string;
  internal_id?: number;
}

export const usaSpendingAdapter: SourceAdapter = {
  sourceKey: 'usaspending_gov',

  async isConfigured(): Promise<boolean> {
    return true; // keyless
  },

  async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
    const pageSize = params.dryRun ? Math.min(params.pageSize ?? 5, 100) : (params.pageSize ?? 100);
    const now = new Date();
    const from = params.since ?? new Date(now.getTime() - 365 * 86_400_000);
    const to = params.until ?? now;

    const naics = params.sectors?.length
      ? params.sectors.map((s) => s.match(/\d{4}/)?.[0] ?? '').filter(Boolean)
      : CONSTRUCTION_NAICS;

    const filters: Record<string, unknown> = {
      award_type_codes: ['A', 'B', 'C', 'D'],
      naics_codes: { require: naics.length ? naics : CONSTRUCTION_NAICS },
      time_period: [{ start_date: from.toISOString().slice(0, 10), end_date: to.toISOString().slice(0, 10) }],
    };
    if (params.keyword?.trim()) filters.keywords = [params.keyword.trim()];
    if (params.minValue) filters.award_amounts = [{ lower_bound: params.minValue }];

    const results: UsaAward[] = [];
    let page = params.page ?? 1;
    const maxPages = params.dryRun ? 1 : 10;

    for (let i = 0; i < maxPages && results.length < pageSize; i++) {
      const res = await fetchWithRetry(
        ENDPOINT,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'EvercamSourceHub/1.0',
          },
          body: JSON.stringify({
            filters,
            fields: [
              'Award ID',
              'Recipient Name',
              'Award Amount',
              'Place of Performance State Code',
              'Description',
              'Awarding Agency Name',
              'Start Date',
            ],
            sort: 'Award Amount',
            order: 'desc',
            limit: Math.min(pageSize, 100),
            page,
          }),
        },
        { timeoutMs: 20_000 }
      );
      if (!res.ok) {
        throw new Error(`USASpending request failed: HTTP ${res.status} ${res.statusText}`);
      }
      let body: { results?: UsaAward[]; page_metadata?: { hasNext?: boolean } };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new AdapterShapeError('USASpending response was not valid JSON.');
      }
      if (!Array.isArray(body.results)) {
        throw new AdapterShapeError('USASpending response had no results array.');
      }
      results.push(...body.results);
      if (params.dryRun || !body.page_metadata?.hasNext || body.results.length < Math.min(pageSize, 100)) break;
      page += 1;
    }

    // regions -> client-side state filter.
    let filtered = results;
    if (params.regions?.length) {
      const wanted = params.regions.map((r) => r.toLowerCase());
      filtered = filtered.filter((a) => {
        const st = (a['Place of Performance State Code'] ?? '').toLowerCase();
        return wanted.some((w) => st === w || w.includes(st) || st.includes(w));
      });
    }

    return filtered.slice(0, pageSize) as unknown as RawProjectRecord[];
  },

  normalize(raw: RawProjectRecord): CanonicalProjectInsert {
    const a = raw as unknown as UsaAward;
    const extId = String(a['Award ID'] ?? a.generated_internal_id ?? a.internal_id ?? '');
    const recipient = a['Recipient Name'] ?? null; // the winning contractor = the account
    const desc = a['Description'] ?? null;
    const amt = a['Award Amount'] != null ? Number(a['Award Amount']) : NaN;
    const value = Number.isNaN(amt) ? null : amt;
    const state = a['Place of Performance State Code'] ?? null;
    const agency = a['Awarding Agency Name'] ?? null;

    const name = recipient
      ? `${recipient}${desc ? ` — ${desc.slice(0, 80)}` : ''}`
      : desc || `USASpending award ${extId}`;

    const presentFields: Partial<Record<CriticalField, boolean>> = {
      project_name: isPresent(name),
      project_value: value != null,
      project_location: isPresent(state),
      project_timeline: isPresent(a['Start Date']),
      building_type: false, // NAICS not returned in this field set
      company_name: isPresent(recipient),
      company_contact: false,
      project_phase: true, // awarded
      square_footage: false,
      funding_source: true, // federal
      company_website: false,
      company_phone: false,
    };

    const completeness = computeCompleteness(presentFields);

    return {
      canonical_name: name.slice(0, 300),
      source_key: 'usaspending_gov',
      source_unique_id: extId,
      icp_code: 'tier1_gc',
      record_type: 'tender',
      bu: 'usa',
      project_type: 'Federal construction award',
      building_type: null,
      description:
        [agency ? `Awarding agency: ${agency}` : null, desc].filter(Boolean).join(' — ').slice(0, 1000) || null,
      address_line1: null,
      city: null,
      state_province: state,
      country: 'US',
      country_code: 'US',
      announced_date: normalizeDate(a['Start Date']),
      construction_start_date: normalizeDate(a['Start Date']),
      estimated_completion_date: null,
      bid_date: null,
      project_url: a.generated_internal_id ? `https://www.usaspending.gov/award/${a.generated_internal_id}` : null,
      current_phase: 'Awarded',
      estimated_value: value,
      estimated_value_currency: value != null ? 'USD' : null,
      company_name_raw: recipient,
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
  const m = value.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}
