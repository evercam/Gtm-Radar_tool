import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { resolveCredentials } from './credentials';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import type { CriticalField } from '@/lib/supabase/types';

/**
 * SAM.gov Federal Opportunities adapter (ICP: critical_infra_owner) — US
 * federal construction procurement (NAICS 23).
 *
 * Endpoint/auth/params/response CONFIRMED by a live-tested reference adapter
 * (Desktop/L1_Evercam/next/lib/adapters/sam-adapter.ts):
 *   - GET https://api.sam.gov/opportunities/v2/search
 *   - Auth: `api_key` QUERY PARAM (free personal key from sam.gov / api.data.gov).
 *   - Params: limit (<=1000), offset, naicsCode, postedFrom/postedTo
 *     (MM/DD/YYYY — a hard requirement), active, sort, q (keyword), ptype.
 *   - Response: { totalRecords, opportunitiesData: [ {...} ] }.
 *
 * This adapter additionally maps `pointOfContact[]` and `award.amount` /
 * `award.awardee` — documented SAM v2 fields the lean reference adapter did
 * not use — so contact + value populate when the notice carries them.
 *
 * Requires an API key stored in `source_credentials` (Settings → API Keys).
 * NOTE: SAM.gov requires postedFrom/postedTo and
 * rejects windows longer than ~1 year, so `since` is clamped to <=1 year back.
 */

const DEFAULT_BASE_URL = 'https://api.sam.gov/opportunities/v2/search';
const DEFAULT_NAICS = '23'; // all construction

interface SamPointOfContact {
  fullName?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  type?: string | null;
}

interface SamAwardee {
  name?: string | null;
}

interface SamOpportunity {
  noticeId?: string;
  title?: string | null;
  solicitationNumber?: string | null;
  fullParentPathName?: string | null; // federal org hierarchy (the "owner")
  organizationHierarchy?: Array<{ name?: string }>;
  naicsCode?: string | null;
  classificationCode?: string | null;
  type?: string | null;
  baseType?: string | null;
  postedDate?: string | null;
  responseDeadLine?: string | null; // bid/response due date
  uiLink?: string | null;
  award?: { amount?: string | number | null; awardee?: SamAwardee | null } | null;
  pointOfContact?: SamPointOfContact[];
  placeOfPerformance?: {
    city?: { code?: string; name?: string } | null;
    state?: { code?: string; name?: string } | null;
    country?: { code?: string; name?: string } | null;
    zip?: string | null;
  } | null;
}

function fmtMMDDYYYY(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/** SAM's `naicsCode` takes a single code; use the first selected sector's leading digits, else all-construction "23". */
function resolveNaics(sectors?: string[]): string {
  if (sectors && sectors.length) {
    const digits = sectors[0].match(/\d{2,6}/)?.[0];
    if (digits) return digits;
  }
  return DEFAULT_NAICS;
}

async function getCredentials(override?: AdapterFetchParams['credentials']) {
  const base = await resolveCredentials('sam_gov', DEFAULT_BASE_URL);
  if (!override) return base;
  return {
    apiKey: override.apiKey?.trim() || base.apiKey,
    apiSecret: override.apiSecret?.trim() || base.apiSecret,
    username: override.username?.trim() || base.username,
    baseUrl: override.baseUrl?.trim() || base.baseUrl,
  };
}

export const samGovAdapter: SourceAdapter = {
  sourceKey: 'sam_gov',

  async isConfigured(): Promise<boolean> {
    const creds = await getCredentials();
    return Boolean(creds.apiKey && creds.baseUrl);
  },

  async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
    const creds = await getCredentials(params.credentials);
    if (!creds.apiKey || !creds.baseUrl) {
      throw new Error(
        'SAM.gov adapter is not configured — add an API key in /control/settings. Get a free key at sam.gov.'
      );
    }
    const endpoint = creds.baseUrl;
    const pageSize = params.dryRun ? Math.min(params.pageSize ?? 5, 100) : (params.pageSize ?? 100);

    const now = new Date();
    // SAM rejects windows > ~1 year; clamp `since`.
    const oneYearBack = new Date(now.getTime() - 364 * 86_400_000);
    let from = params.since ?? oneYearBack;
    if (from.getTime() < oneYearBack.getTime()) from = oneYearBack;
    const to = params.until ?? now;

    const results: SamOpportunity[] = [];
    let offset = ((params.page ?? 1) - 1) * pageSize;
    const maxPages = params.dryRun ? 1 : 50;

    for (let i = 0; i < maxPages && results.length < pageSize; i++) {
      const qp = new URLSearchParams({
        api_key: creds.apiKey,
        limit: String(Math.min(pageSize, 1000)),
        offset: String(offset),
        naicsCode: resolveNaics(params.sectors),
        postedFrom: fmtMMDDYYYY(from),
        postedTo: fmtMMDDYYYY(to),
        active: 'true',
        sort: '-modifiedDate',
      });
      if (params.keyword?.trim()) qp.set('q', params.keyword.trim());

      const res = await fetchWithRetry(
        `${endpoint}?${qp.toString()}`,
        { headers: { Accept: 'application/json', 'User-Agent': 'EvercamSourceHub/1.0' } },
        { timeoutMs: 20_000 }
      );
      if (!res.ok) {
        throw new Error(`SAM.gov request failed: HTTP ${res.status} ${res.statusText}`);
      }

      let body: { opportunitiesData?: SamOpportunity[]; totalRecords?: number };
      try {
        body = await res.json();
      } catch {
        throw new AdapterShapeError('SAM.gov response was not valid JSON.');
      }
      if (!body || !Array.isArray(body.opportunitiesData)) {
        throw new AdapterShapeError('SAM.gov response did not contain an "opportunitiesData" array.');
      }

      results.push(...body.opportunitiesData);
      if (params.dryRun || body.opportunitiesData.length < Math.min(pageSize, 1000)) break;
      offset += body.opportunitiesData.length;
    }

    // Client-side filters SAM's search doesn't apply server-side.
    let filtered = results;
    if (params.regions?.length) {
      const wanted = params.regions.map((r) => r.toLowerCase());
      filtered = filtered.filter((o) => {
        const hay = [
          o.placeOfPerformance?.state?.name,
          o.placeOfPerformance?.state?.code,
          o.placeOfPerformance?.city?.name,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return wanted.some((r) => hay.includes(r));
      });
    }
    if (params.minValue) {
      filtered = filtered.filter((o) => {
        const amt = o.award?.amount != null ? Number(o.award.amount) : NaN;
        return !Number.isNaN(amt) && amt >= params.minValue!;
      });
    }

    return filtered.slice(0, pageSize) as unknown as RawProjectRecord[];
  },

  normalize(raw: RawProjectRecord): CanonicalProjectInsert {
    const o = raw as unknown as SamOpportunity;
    const extId = String(o.noticeId ?? o.solicitationNumber ?? '');

    const projectName = o.title ?? null;
    const awardAmount = o.award?.amount != null ? Number(o.award.amount) : NaN;
    const projectValue = Number.isNaN(awardAmount) ? null : awardAmount;
    const state = o.placeOfPerformance?.state?.name ?? o.placeOfPerformance?.state?.code ?? null;
    const city = o.placeOfPerformance?.city?.name ?? null;
    const country = o.placeOfPerformance?.country?.code ?? 'US';
    const buildingType = o.naicsCode ? `NAICS ${o.naicsCode}` : (o.classificationCode ?? null);
    const phase = o.baseType ?? o.type ?? null;
    // Owner = awardee if awarded, else the federal contracting organization.
    const companyName = o.award?.awardee?.name || o.fullParentPathName || o.organizationHierarchy?.[0]?.name || null;
    const poc = (o.pointOfContact ?? []).find((c) => isPresent(c.fullName)) ?? o.pointOfContact?.[0] ?? null;
    const contactName = poc?.fullName ?? null;
    const contactPhone = poc?.phone ?? null;

    const presentFields: Partial<Record<CriticalField, boolean>> = {
      project_name: isPresent(projectName),
      project_value: isPresent(projectValue),
      project_location: isPresent(state) || isPresent(city),
      project_timeline: isPresent(o.postedDate) || isPresent(o.responseDeadLine),
      building_type: isPresent(buildingType),
      company_name: isPresent(companyName),
      company_contact: isPresent(contactName),
      project_phase: isPresent(phase),
      square_footage: false, // not exposed
      funding_source: true, // always federal public procurement
      company_website: false, // not exposed
      company_phone: isPresent(contactPhone),
    };

    const completeness = computeCompleteness(presentFields);

    return {
      canonical_name: projectName ?? `SAM.gov notice ${extId}`,
      source_key: 'sam_gov',
      source_unique_id: extId,
      icp_code: 'critical_infra_owner',
      record_type: 'tender',
      bu: 'usa',
      project_type: o.type ?? null,
      building_type: buildingType,
      description:
        [o.baseType, o.solicitationNumber ? `Sol# ${o.solicitationNumber}` : null].filter(Boolean).join(' — ') || null,
      address_line1: null,
      city,
      state_province: state,
      country: country.toUpperCase(),
      country_code: country.slice(0, 2).toUpperCase(),
      announced_date: normalizeDate(o.postedDate),
      construction_start_date: null,
      estimated_completion_date: null,
      bid_date: normalizeDate(o.responseDeadLine),
      project_url: o.uiLink ?? (extId ? `https://sam.gov/opp/${extId}/view` : null),
      current_phase: phase,
      estimated_value: projectValue,
      estimated_value_currency: projectValue !== null ? 'USD' : null,
      company_name_raw: companyName,
      contact_name: contactName,
      contact_title: poc?.title ?? null,
      contact_email: poc?.email ?? null,
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
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
