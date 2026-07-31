import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { resolveCredentials } from './credentials';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import type { CriticalField } from '@/lib/supabase/types';

/**
 * ConstructConnect adapter (ICP: tier1_gc) — US/Canada commercial construction
 * project intelligence. Verified live on 2026-07-24 against the production API.
 *
 * SHAPE CONFIRMED against a real 200 response:
 *   - Base URL:  https://api.io.constructconnect.com/search/v1
 *   - Endpoint:  POST /ProjectLeads
 *   - Auth:      `x-api-key` QUERY PARAM (a header is rejected with
 *                401 "ApiKey is missing. The parameter 'x-api-key' should be
 *                specified.") — so the key goes on the URL, not in a header.
 *   - Body:      { sort, sortDir, limit, offset, filters: {
 *                   contentType: "CuratedProject",   // always
 *                   category?: string[],             // e.g. ["Retail"]
 *                   minProjectValue?, maxProjectValue?: number (USD),
 *                   location?: { locationType: "City"|"County"|"State"|"Radius", ... }
 *                } }
 *   - Response:  { numFound: number, start: number, docs: [ {...} ], facets }
 *
 * Confirmed doc fields: projectId, id, uniqueProjectId, title, projectUrl,
 * projectDescription, projectValue (USD number), projectValueRange[],
 * projectStatus, propertyType, categories[], buildingUsesString, sectors[]
 * (e.g. "Public - County" / "Private"), address {city,county,state,stateCode,
 * countryCode}, location {latitude,longitude}, companyNameList[], companyId[],
 * bidDate, startDate, createdProjectDate, lastUpdatedDate, contractingMethod.
 *
 * ConstructConnect does NOT expose a contact person or company phone/website
 * on ProjectLeads, so those completeness fields resolve false.
 *
 * ProjectLeads has no confirmed server-side date-range filter in the public
 * collection, so `since`/`until`, `keyword`, and `regions` are applied
 * client-side after fetch (like Glenigan). `sectors` -> filters.category and
 * `minValue` -> filters.minProjectValue ARE server-side.
 */

const DEFAULT_BASE_URL = 'https://api.io.constructconnect.com/search/v1';

interface CcAddress {
  city?: string | null;
  county?: string | null;
  state?: string | null;
  stateCode?: string | null;
  countryCode?: string | null;
}

interface CcDoc {
  projectId?: number;
  id?: string;
  uniqueProjectId?: string;
  title?: string | null;
  projectUrl?: string | null;
  projectDescription?: string | null;
  projectValue?: number | null;
  projectValueRange?: string[];
  projectStatus?: string | null;
  propertyType?: string | null;
  projectCategory?: string | null;
  categories?: string[];
  subCategories?: string[];
  buildingUsesString?: string | null;
  sectors?: string[];
  address?: CcAddress | null;
  location?: { latitude?: number; longitude?: number } | null;
  companyNameList?: string[];
  bidDate?: string | null;
  startDate?: string | null;
  createdProjectDate?: string | null;
  contractingMethod?: string | null;
}

async function getCredentials(override?: AdapterFetchParams['credentials']) {
  const base = await resolveCredentials('construct_connect', DEFAULT_BASE_URL);
  if (!override) return base;
  return {
    apiKey: override.apiKey?.trim() || base.apiKey,
    apiSecret: override.apiSecret?.trim() || base.apiSecret,
    username: override.username?.trim() || base.username,
    baseUrl: override.baseUrl?.trim() || base.baseUrl,
  };
}

export const constructConnectAdapter: SourceAdapter = {
  sourceKey: 'construct_connect',

  async isConfigured(): Promise<boolean> {
    const creds = await getCredentials();
    return Boolean(creds.apiKey && creds.baseUrl);
  },

  async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
    const creds = await getCredentials(params.credentials);
    if (!creds.apiKey || !creds.baseUrl) {
      throw new Error(
        'ConstructConnect adapter is not configured — add an API key in /control/settings.'
      );
    }
    const baseUrl = creds.baseUrl.replace(/\/$/, '');
    const pageSize = params.dryRun ? Math.min(params.pageSize ?? 5, 50) : (params.pageSize ?? 100);

    const filters: Record<string, unknown> = { contentType: 'CuratedProject' };
    if (params.sectors?.length) filters.category = params.sectors;
    if (params.minValue) filters.minProjectValue = params.minValue;

    const results: CcDoc[] = [];
    let offset = ((params.page ?? 1) - 1) * pageSize;
    const maxPages = params.dryRun ? 1 : 200; // safety cap

    for (let i = 0; i < maxPages && results.length < pageSize; i++) {
      const url = `${baseUrl}/ProjectLeads?x-api-key=${encodeURIComponent(creds.apiKey)}`;
      const res = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'EvercamSourceHub/1.0',
          },
          body: JSON.stringify({ sort: 'title', sortDir: 'asc', limit: Math.min(pageSize, 150), offset, filters }),
        },
        { timeoutMs: 20_000 }
      );
      if (!res.ok) {
        throw new Error(`ConstructConnect request failed: HTTP ${res.status} ${res.statusText}`);
      }

      let body: { docs?: CcDoc[]; numFound?: number };
      try {
        body = await res.json();
      } catch {
        throw new AdapterShapeError('ConstructConnect response was not valid JSON.');
      }
      if (!body || !Array.isArray(body.docs)) {
        throw new AdapterShapeError('ConstructConnect response did not contain a "docs" array.');
      }

      results.push(...body.docs);
      if (params.dryRun || body.docs.length < Math.min(pageSize, 150)) break;
      offset += body.docs.length;
    }

    // Client-side filters ConstructConnect's ProjectLeads doesn't apply server-side.
    let filtered = results;
    if (params.since || params.until) {
      const sinceT = params.since ? params.since.getTime() : -Infinity;
      const untilT = params.until ? params.until.getTime() : Infinity;
      filtered = filtered.filter((d) => {
        const raw = d.createdProjectDate || d.startDate || d.bidDate;
        if (!raw) return true;
        const t = new Date(raw).getTime();
        return Number.isNaN(t) || (t >= sinceT && t <= untilT);
      });
    }
    if (params.regions?.length) {
      const wanted = params.regions.map((r) => r.toLowerCase());
      filtered = filtered.filter((d) => {
        const hay = [d.address?.state, d.address?.county, d.address?.city].filter(Boolean).join(' ').toLowerCase();
        return wanted.some((r) => hay.includes(r));
      });
    }
    if (params.keyword?.trim()) {
      const kw = params.keyword.trim().toLowerCase();
      filtered = filtered.filter((d) =>
        [d.title, d.projectDescription].filter(Boolean).join(' ').toLowerCase().includes(kw)
      );
    }

    return filtered.slice(0, pageSize) as unknown as RawProjectRecord[];
  },

  normalize(raw: RawProjectRecord): CanonicalProjectInsert {
    const d = raw as unknown as CcDoc;
    const extId = String(d.projectId ?? d.uniqueProjectId ?? d.id ?? '');

    const projectName = d.title ?? null;
    const projectValue = typeof d.projectValue === 'number' ? d.projectValue : null;
    const buildingType = d.categories?.[0] || d.buildingUsesString || d.propertyType || null;
    const companyName = d.companyNameList?.[0] ?? null;
    const phase = d.projectStatus ?? null;
    // sectors like "Public - County" / "Private" describe funding source.
    const fundingSource = d.sectors && d.sectors.length ? d.sectors.join(', ') : null;
    const city = d.address?.city ?? null;
    const state = d.address?.state ?? null;
    const country = d.address?.countryCode ? d.address.countryCode.toUpperCase() : 'US';

    const presentFields: Partial<Record<CriticalField, boolean>> = {
      project_name: isPresent(projectName),
      project_value: isPresent(projectValue),
      project_location: isPresent(city) || isPresent(state),
      project_timeline: isPresent(d.startDate) || isPresent(d.bidDate) || isPresent(d.createdProjectDate),
      building_type: isPresent(buildingType),
      company_name: isPresent(companyName),
      company_contact: false, // no contact person on ProjectLeads
      project_phase: isPresent(phase),
      square_footage: false, // not exposed
      funding_source: isPresent(fundingSource),
      company_website: false, // not exposed
      company_phone: false, // not exposed
    };

    const completeness = computeCompleteness(presentFields);

    return {
      canonical_name: projectName ?? `ConstructConnect project ${extId}`,
      source_key: 'construct_connect',
      source_unique_id: extId,
      icp_code: 'tier1_gc',
      record_type: 'project',
      bu: 'usa',
      project_type: d.projectCategory || null,
      building_type: buildingType,
      description: d.projectDescription ?? null,
      address_line1: null,
      city,
      state_province: state,
      country,
      country_code: (d.address?.countryCode ?? 'us').slice(0, 2).toUpperCase(),
      latitude: typeof d.location?.latitude === 'number' ? d.location.latitude : null,
      longitude: typeof d.location?.longitude === 'number' ? d.location.longitude : null,
      announced_date: normalizeDate(d.createdProjectDate),
      construction_start_date: normalizeDate(d.startDate),
      estimated_completion_date: null,
      bid_date: normalizeDate(d.bidDate),
      project_url: d.projectUrl ?? null,
      current_phase: phase,
      estimated_value: projectValue,
      estimated_value_currency: projectValue !== null ? 'USD' : null,
      company_name_raw: companyName,
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
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}
