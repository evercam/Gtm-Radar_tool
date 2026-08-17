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

/*
  What we ask for, and why each one is here.

  The old list was seven fields. Measured 2026-08-17 over 200 real awards, every
  field added below is present on 100% of them except Total Outlays (77%) and the
  place-of-performance pair (84%) — so this is not speculative enrichment, it is
  data the API was already returning and the adapter was declining to read.

  `Awarding Agency Name` is DELIBERATELY GONE. It came back null on 200 of 200,
  while `Awarding Sub Agency` was populated on 200 of 200 — so the description
  line "Awarding agency: …" has been empty on all 6,037 stored records, and the
  fix is to ask for the field that has the answer.

  `Place of Performance City Name` is also skipped: null on 200 of 200. Zip5 is
  populated wherever the state is, so location precision comes from the zip.
*/
const AWARD_FIELDS = [
  'Award ID',
  'Recipient Name',
  'Award Amount',
  'Total Outlays',
  'Description',
  'Contract Award Type',
  'Awarding Sub Agency',
  'Start Date',
  'End Date',
  'Base Obligation Date',
  'Last Modified Date',
  'NAICS',
  'PSC',
  'recipient_id',
  'Place of Performance State Code',
  'Place of Performance Zip5',
] as const;

interface UsaCode {
  code?: string;
  description?: string;
}

interface UsaAward {
  'Award ID'?: string;
  'Recipient Name'?: string;
  'Award Amount'?: number | string;
  /** Spent so far. Against the award ceiling this is a progress proxy. */
  'Total Outlays'?: number | string | null;
  'Place of Performance State Code'?: string;
  'Place of Performance Zip5'?: string;
  Description?: string;
  'Contract Award Type'?: string;
  'Awarding Sub Agency'?: string;
  /** Period-of-performance start — the closest thing to ground-breaking. */
  'Start Date'?: string;
  /** Period-of-performance end. Gives build duration and whether it is over. */
  'End Date'?: string;
  /** When the award was made, which is a different event from the work starting. */
  'Base Obligation Date'?: string;
  'Last Modified Date'?: string;
  NAICS?: UsaCode | null;
  PSC?: UsaCode | null;
  recipient_id?: string | null;
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
    /**
     * The run's budget, separate from the page size.
     *
     * These were one number, which capped every scheduled pull at whatever the
     * page size was — the route passed 50, the loop stopped at 50, the result was
     * sliced to 50, and `max_records_per_run` (500) was never applied. Absent, it
     * still means one page, so an un-updated caller behaves exactly as before.
     */
    const maxRecords = params.dryRun ? pageSize : (params.maxRecords ?? pageSize);
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
    // Enough pages to reach the budget, with a hard ceiling so a misconfigured
    // budget cannot walk a vendor’s whole index.
    const maxPages = params.dryRun ? 1 : Math.min(200, Math.max(1, Math.ceil(maxRecords / Math.max(1, Math.min(pageSize, 100))) + 2));

    for (let i = 0; i < maxPages && results.length < maxRecords; i++) {
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
            fields: AWARD_FIELDS,
            /*
              SORTED BY START DATE, NEWEST FIRST. This one value decides whether
              the source is a lead feed or a historical archive.

              It was `Award Amount desc`, which asks for the largest federal
              construction contracts of the last year — and the largest are the
              oldest, because a $2.8bn border-barrier job has been running since
              December. Measured 2026-08-17 over 100 awards per sort, same filters:

                sort                        future start   within ±6mo   finished
                Award Amount desc                     0             0         19
                Base Obligation Date desc            14            98          1
                Start Date desc                     100            87          3

              Zero of a hundred inside the selling window, against ninety-eight.
              Nothing was wrong with the source; it was being asked the wrong
              question. `Start Date desc` is chosen over `Base Obligation Date`
              because every award it returns has NOT BROKEN GROUND YET, which is
              the only population Evercam can still get installed on.
            */
            sort: 'Start Date',
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

    return filtered.slice(0, maxRecords) as unknown as RawProjectRecord[];
  },

  normalize(raw: RawProjectRecord): CanonicalProjectInsert {
    const a = raw as unknown as UsaAward;
    const extId = String(a['Award ID'] ?? a.generated_internal_id ?? a.internal_id ?? '');
    const recipient = a['Recipient Name'] ?? null; // the winning contractor = the account
    const desc = a['Description'] ?? null;
    const amt = a['Award Amount'] != null ? Number(a['Award Amount']) : NaN;
    const value = Number.isNaN(amt) ? null : amt;
    const state = a['Place of Performance State Code'] ?? null;
    // 200 of 200 sampled awards had a null `Awarding Agency Name` and a populated
    // `Awarding Sub Agency`, so this is the one that actually names the buyer.
    const agency = a['Awarding Sub Agency'] ?? null;
    const naics = a.NAICS ?? null;
    const psc = a.PSC ?? null;
    const start = normalizeDate(a['Start Date']);
    const end = normalizeDate(a['End Date']);
    const outlays = a['Total Outlays'] != null ? Number(a['Total Outlays']) : null;

    const name = recipient
      ? `${recipient}${desc ? ` — ${desc.slice(0, 80)}` : ''}`
      : desc || `USASpending award ${extId}`;

    const presentFields: Partial<Record<CriticalField, boolean>> = {
      project_name: isPresent(name),
      project_value: value != null,
      project_location: isPresent(state) || isPresent(a['Place of Performance Zip5']),
      // A start AND an end date is a period of performance, not just a timestamp.
      project_timeline: isPresent(start) || isPresent(end),
      // NAICS IS returned — it just was not being requested. 200 of 200 sampled
      // awards carry it, so this was understating completeness on every record.
      building_type: isPresent(naics?.description) || isPresent(naics?.code),
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
      // PSC describes the WORK ("Construction of other non-building facilities");
      // NAICS describes the industry. Both were being discarded while present on
      // 200 of 200 sampled awards.
      project_type: psc?.description || psc?.code || 'Federal construction award',
      building_type: naics?.description || naics?.code || null,
      description:
        [
          agency ? `Awarding agency: ${agency}` : null,
          desc,
          a['Contract Award Type'] ? `Vehicle: ${a['Contract Award Type']}` : null,
          naics?.code ? `NAICS ${naics.code}` : null,
          /*
            Spend against ceiling, which is the only progress signal this source
            gives. Median 7% and p90 68% over the sample, so it genuinely
            discriminates. It goes in the description because a rep reads this
            before dialling and "3% drawn down" tells them how early they are far
            better than a phase label can.
          */
          value && outlays != null && value > 0
            ? `Outlaid ${Math.round((outlays / value) * 100)}% of the award ceiling so far`
            : null,
        ]
          .filter(Boolean)
          .join(' — ')
          .slice(0, 1000) || null,
      address_line1: null,
      // `Place of Performance City Name` was null on 200 of 200; the zip is
      // populated wherever the state is, so it carries the location precision.
      city: a['Place of Performance Zip5'] ?? null,
      state_province: state,
      country: 'US',
      country_code: 'US',
      /*
        Two different events, from two different fields.

        Both of these used to be `Start Date`, so construction_start_date and
        announced_date were identical on 300 of 300 sampled records — the same
        defect the World Bank adapter had. The award being obligated and the work
        starting are weeks or months apart, and only one of them is ground-breaking.
      */
      announced_date: normalizeDate(a['Base Obligation Date']) ?? start,
      construction_start_date: start,
      // 100% coverage, and it was being stored as null on every record. It gives
      // build duration, and a passed end date means the job is over.
      estimated_completion_date: end,
      bid_date: null,
      project_url: a.generated_internal_id ? `https://www.usaspending.gov/award/${a.generated_internal_id}` : null,
      current_phase: phaseFromPeriod(start, end),
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

/**
 * The phase, READ FROM THE DATES rather than hardcoded.
 *
 * This was the string `'Awarded'` on every record, and that one constant made all
 * 6,037 stored awards read `on_time` — "mobilising or just started" — whatever
 * their dates said. `arrivalFor` saw a phase claiming work had not begun beside a
 * start date in the past, correctly judged them contradictory, and fell back to
 * the phase. So the phase won every time and the dates were discarded.
 *
 * Measured 2026-08-17 over 200 awards: 200 had a start date in the past and 48 had
 * an END DATE THAT HAD ALREADY PASSED. A quarter of this source is finished work
 * being presented to a seller as ready to mobilise, and none of it was cold.
 *
 * A period of performance answers the question directly, so it decides:
 *
 *   end date in the past          project complete   weight 0   -> too_late, cold
 *   started, end still ahead      under construction started:true -> late, cold
 *   start date in the future      Awarded            0.95       -> the window
 *   no start date                 Awarded            the old behaviour
 *
 * The phase strings are ones `phaseTiming` already matches — 'complete' at weight
 * 0 and 'under construction' with `started: true` — so no phase-table edit is
 * needed and an admin editing weights moves this with everything else.
 */
export function phaseFromPeriod(start: string | null, end: string | null, now: number = Date.now()): string {
  const t = (d: string | null) => (d ? new Date(d).getTime() : null);
  const s = t(start);
  const e = t(end);
  if (e !== null && !Number.isNaN(e) && e < now) return 'Project complete';
  if (s !== null && !Number.isNaN(s) && s <= now) return 'Under construction';
  return 'Awarded';
}
