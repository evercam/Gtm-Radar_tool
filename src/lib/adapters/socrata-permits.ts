import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import { readSecret } from '@/lib/crypto/store';
import type { CriticalField, BusinessUnit } from '@/lib/supabase/types';

/**
 * Generic Socrata (SODA) building-permit adapter factory. Powers two KEYLESS,
 * live-verified US municipal open-data permit feeds — the US counterpart to the
 * Ireland planning feed (planning-ie.ts):
 *   - NYC DOB Permit Issuance (data.cityofnewyork.us / ipu4-2q9a) — BU usa
 *   - Chicago Building Permits (data.cityofchicago.org / ydr8-5enu) — BU usa
 *
 * Both are SODA 2.1 datasets returning a bare JSON array of row objects. Field
 * names differ per city, so each publisher supplies its own `extract()` mapper;
 * the fetch loop, filtering, and normalize scaffold are shared. Server-side
 * filters used (SoQL): `$where` (date window on the issuance/issue field),
 * `$q` (free-text keyword), `$order`, `$limit`, `$offset`. `minValue` and
 * `regions` are applied client-side. An optional SOCRATA_APP_TOKEN raises the
 * per-IP throttle but is NOT required. Verified live 2026-07-25.
 */

interface ExtractedPermit {
  extId: string;
  name: string | null;
  description: string | null;
  buildingType: string | null;
  value: number | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  filedDate: string | null;
  issuedDate: string | null;
  startDate: string | null;
  companyName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  currentPhase: string | null;
  url: string | null;
}

export interface SocrataPermitConfig {
  slug: string; // URL slug used by /api/search & /api/ingest
  sourceKey: string; // source_registry.source_key
  icpCode: string;
  bu: BusinessUnit;
  countryCode: string; // ISO-2
  host: string; // e.g. data.cityofnewyork.us
  datasetId: string; // e.g. ipu4-2q9a
  /** Floating-timestamp column used for the date window + ordering. */
  dateField: string;
  /** Map one raw SODA row to the subset of fields we normalize. */
  extract: (raw: RawProjectRecord) => ExtractedPermit;
}

// ---- helpers ----------------------------------------------------------------

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** SODA floating timestamps ("2024-05-01T00:00:00.000") -> YYYY-MM-DD. */
function isoDay(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function joinNonEmpty(parts: (string | null | undefined)[], sep = ' '): string | null {
  const out = parts
    .map((p) => (p == null ? '' : String(p).trim()))
    .filter(Boolean)
    .join(sep);
  return out.length ? out : null;
}

// ---- publisher extractors ---------------------------------------------------

/** NYC DOB Permit Issuance (ipu4-2q9a). The permittee = the licensed contractor
 *  running the job (the actionable account); the dataset carries their business
 *  name AND phone. No estimated cost is published in this dataset. */
function extractNyc(raw: RawProjectRecord): ExtractedPermit {
  const r = raw as Record<string, unknown>;
  const house = str(r.house__);
  const street = str(r.street_name);
  const borough = str(r.borough);
  const address = joinNonEmpty([house, street]);
  const workType = str(r.work_type);
  const jobType = str(r.job_type);
  const bin = str(r.bin__);
  const permittee =
    str(r.permittee_s_business_name) || joinNonEmpty([str(r.permittee_s_first_name), str(r.permittee_s_last_name)]);
  const contactName = joinNonEmpty([str(r.permittee_s_first_name), str(r.permittee_s_last_name)]);

  const name =
    joinNonEmpty([workType || jobType || 'Building work', '—', address, borough]) ||
    `NYC DOB permit ${str(r.permit_si_no) ?? ''}`.trim();

  return {
    extId: str(r.permit_si_no) || joinNonEmpty([str(r.job__), str(r.permit_sequence__)], '-') || '',
    name,
    description: joinNonEmpty(
      [str(r.permit_type), str(r.permit_subtype), workType, jobType && `job type ${jobType}`],
      ' · '
    ),
    buildingType: workType || jobType || null,
    value: null, // permit-issuance dataset has no estimated cost
    addressLine1: address,
    city: borough,
    state: 'NY',
    latitude: num(r.gis_latitude),
    longitude: num(r.gis_longitude),
    filedDate: isoDay(r.filing_date),
    issuedDate: isoDay(r.issuance_date),
    startDate: isoDay(r.job_start_date),
    companyName: permittee,
    contactName,
    contactPhone: str(r.permittee_s_phone__),
    currentPhase: str(r.permit_status) || (r.issuance_date ? 'Issued' : null),
    url: bin ? `http://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?bin=${bin}` : null,
  };
}

/** Chicago Building Permits (ydr8-5enu). `reported_cost` gives an estimated
 *  project value; `contact_1_name` is the primary contact (contractor/owner). */
function extractChicago(raw: RawProjectRecord): ExtractedPermit {
  const r = raw as Record<string, unknown>;
  const address = joinNonEmpty([str(r.street_number), str(r.street_direction), str(r.street_name)]);
  const permitType = str(r.permit_type);
  const desc = str(r.work_description);
  const issued = isoDay(r.issue_date);

  return {
    extId: str(r.id) || str(r.permit_) || '',
    name: (desc && desc.slice(0, 200)) || permitType || `Chicago permit ${str(r.permit_) ?? ''}`.trim(),
    description: joinNonEmpty([permitType, str(r.review_type), desc], ' · '),
    buildingType: permitType,
    value: num(r.reported_cost),
    addressLine1: address,
    city: 'Chicago',
    state: 'IL',
    latitude: num(r.latitude),
    longitude: num(r.longitude),
    filedDate: isoDay(r.application_start_date),
    issuedDate: issued,
    startDate: null,
    companyName: str(r.contact_1_name),
    contactName: str(r.contact_1_name),
    contactPhone: null,
    currentPhase: issued ? 'Issued' : 'Application',
    url: null,
  };
}

// ---- publisher registry -----------------------------------------------------

export const SOCRATA_PERMIT_PUBLISHERS: SocrataPermitConfig[] = [
  {
    slug: 'nyc-permits',
    sourceKey: 'nyc_dob_permits',
    icpCode: 'tier2_gc',
    bu: 'usa',
    countryCode: 'US',
    host: 'data.cityofnewyork.us',
    datasetId: 'ipu4-2q9a',
    dateField: 'issuance_date',
    extract: extractNyc,
  },
  {
    slug: 'chicago-permits',
    sourceKey: 'chicago_building_permits',
    icpCode: 'tier2_gc',
    bu: 'usa',
    countryCode: 'US',
    host: 'data.cityofchicago.org',
    datasetId: 'ydr8-5enu',
    dateField: 'issue_date',
    extract: extractChicago,
  },
];

function makeSocrataAdapter(cfg: SocrataPermitConfig): SourceAdapter {
  return {
    sourceKey: cfg.sourceKey,

    async isConfigured(): Promise<boolean> {
      return true; // keyless (app token optional)
    },

    async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
      const baseUrl = `https://${cfg.host}/resource/${cfg.datasetId}.json`;
      const pageSize = params.dryRun ? Math.min(params.pageSize ?? 5, 100) : (params.pageSize ?? 100);

      // Server-side SoQL date window on the publisher's issuance field.
      const whereParts: string[] = [];
      if (params.since) whereParts.push(`${cfg.dateField} >= '${params.since.toISOString().slice(0, 19)}'`);
      if (params.until) whereParts.push(`${cfg.dateField} <= '${params.until.toISOString().slice(0, 19)}'`);

      const rows: RawProjectRecord[] = [];
      let offset = ((params.page ?? 1) - 1) * pageSize;
      const maxPages = params.dryRun ? 1 : 10;
      const perPage = Math.min(pageSize, 200);

      // Free and self-serve, and it lifts NYC/Chicago off a shared-IP throttle
      // onto 1,000 requests an hour. Resolved from the encrypted store like
      // every other key; absent is fine, it just means the shared-IP limit.
      const appToken = params.credentials?.apiKey?.trim() || (await readSecret('socrata_app_token'))?.trim();
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': 'EvercamSourceHub/1.0',
      };
      if (appToken) headers['X-App-Token'] = appToken;

      for (let i = 0; i < maxPages && rows.length < pageSize; i++) {
        const url = new URL(baseUrl);
        url.searchParams.set('$limit', String(perPage));
        url.searchParams.set('$offset', String(offset));
        url.searchParams.set('$order', `${cfg.dateField} DESC`);
        if (whereParts.length) url.searchParams.set('$where', whereParts.join(' AND '));
        if (params.keyword?.trim()) url.searchParams.set('$q', params.keyword.trim());

        const res = await fetchWithRetry(url.toString(), { headers }, { timeoutMs: 20_000 });
        if (!res.ok) {
          throw new Error(`${cfg.slug} Socrata request failed: HTTP ${res.status} ${res.statusText}`);
        }
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          throw new AdapterShapeError(`${cfg.slug} Socrata response was not valid JSON.`);
        }
        if (!Array.isArray(body)) {
          throw new AdapterShapeError(`${cfg.slug} Socrata response was not a JSON array.`);
        }
        rows.push(...(body as RawProjectRecord[]));
        if (params.dryRun || body.length < perPage) break;
        offset += body.length;
      }

      // Client-side value + region filters (SoQL column names vary per city, so
      // these are applied post-extract for portability).
      let filtered = rows;
      if (params.minValue || params.regions?.length) {
        const wanted = (params.regions ?? []).map((r) => r.toLowerCase());
        filtered = rows.filter((raw) => {
          const e = cfg.extract(raw);
          if (params.minValue && !(e.value != null && e.value >= params.minValue)) return false;
          if (wanted.length) {
            const hay = joinNonEmpty([e.addressLine1, e.city, e.state], ' ')?.toLowerCase() ?? '';
            if (!wanted.some((w) => hay.includes(w))) return false;
          }
          return true;
        });
      }

      return filtered.slice(0, pageSize);
    },

    normalize(raw: RawProjectRecord): CanonicalProjectInsert {
      const e = cfg.extract(raw);

      const presentFields: Partial<Record<CriticalField, boolean>> = {
        project_name: isPresent(e.name),
        project_value: e.value != null,
        project_location: isPresent(e.addressLine1) || isPresent(e.city),
        project_timeline: isPresent(e.issuedDate) || isPresent(e.filedDate),
        building_type: isPresent(e.buildingType),
        company_name: isPresent(e.companyName),
        company_contact: isPresent(e.contactName),
        project_phase: isPresent(e.currentPhase),
        square_footage: false,
        funding_source: false, // private construction
        company_website: false,
        company_phone: isPresent(e.contactPhone),
      };

      const completeness = computeCompleteness(presentFields);

      return {
        canonical_name: (e.name ?? `Building permit ${e.extId}`).slice(0, 300),
        source_key: cfg.sourceKey,
        source_unique_id: e.extId,
        icp_code: cfg.icpCode,
        record_type: 'permit',
        bu: cfg.bu,
        project_type: e.buildingType,
        building_type: e.buildingType,
        description: e.description ? e.description.slice(0, 1000) : null,
        address_line1: e.addressLine1,
        city: e.city,
        state_province: e.state,
        country: cfg.countryCode,
        country_code: cfg.countryCode,
        latitude: e.latitude,
        longitude: e.longitude,
        announced_date: e.filedDate ?? e.issuedDate,
        construction_start_date: e.startDate ?? e.issuedDate,
        estimated_completion_date: null,
        bid_date: null,
        project_url: e.url,
        current_phase: e.currentPhase,
        estimated_value: e.value,
        estimated_value_currency: e.value != null ? 'USD' : null,
        company_name_raw: e.companyName,
        contact_name: e.contactName,
        contact_title: null,
        contact_email: null,
        contact_phone: e.contactPhone,
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
}

export const nycPermitsAdapter = makeSocrataAdapter(SOCRATA_PERMIT_PUBLISHERS[0]);
export const chicagoPermitsAdapter = makeSocrataAdapter(SOCRATA_PERMIT_PUBLISHERS[1]);
