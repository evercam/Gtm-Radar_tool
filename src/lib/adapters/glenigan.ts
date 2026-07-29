import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { resolveCredentials } from './credentials';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import type { CriticalField } from '@/lib/supabase/types';

/**
 * Glenigan adapter — auth and pagination mechanics ported from a reference
 * adapter, but the response shape below was captured directly from a LIVE
 * call against `GET /project/newproject` with a real key on 2026-07-24 (see
 * project notes) — it supersedes the reference adapter's assumed shape,
 * which turned out to be stale/incorrect. Auth is a single `key` query param
 * on every call.
 *
 * Confirmed response shape: `{ total: number, results: [{ id, source: {...} }] }`.
 * `source.Value` is denominated in MILLIONS of GBP (0.8 == £800,000).
 * `source.Client` / `source.OfficeNames` are tilde/`~`-joined
 * "Name~OfficeId" strings; the first segment is the company name.
 * `source.RolesDetails[].Roles[].CompaniesInRole[].ContactsInCompanyInRole[]`
 * holds contact name/phone/title when present.
 *
 * Requires GLENIGAN_API_KEY.
 */

const DEFAULT_BASE_URL = 'https://www.gleniganapi.com/glenigan';
const MAX_PAGE_SIZE = 50; // documented hard cap

interface GleniganContact {
  KeyCard_FullContact?: string | null;
  KeyCard_Phone1?: string | null;
  JobTitleForThisProject?: string | null;
}

interface GleniganCompanyInRole {
  ContactsInCompanyInRole?: GleniganContact[];
}

interface GleniganRole {
  CompaniesInRole?: GleniganCompanyInRole[];
}

interface GleniganRoleGroup {
  Roles?: GleniganRole[];
}

interface GleniganRoleListEntry {
  KeyCard_ContractPhone1?: string | null;
}

interface GleniganSector {
  BuildingType?: string | null;
  FloorArea?: number | null;
}

interface GleniganSource {
  ProjectId?: string;
  Heading?: string | null;
  PrimaryHeading?: string | null;
  SecondaryHeading?: string | null;
  SiteName?: string | null;
  ProjectName?: string | null;
  PrimarySectors?: string | null;
  SecondarySectors?: string | null;
  DevelopmentType?: string | null;
  Sectors?: GleniganSector[];
  FloorArea?: number | null;
  Address?: string | null;
  AddressLine1?: string | null;
  AddressLine2?: string | null;
  AddressLine3?: string | null;
  ProjectTown?: string | null;
  ProjectCounty?: string | null;
  ProjectRegion?: string | null;
  ProjectPostcode?: string | null;
  ProjectLocation?: { lat?: number; lon?: number } | null;
  Value?: number | null; // millions GBP
  ValueType?: string | null;
  PlanningStageParent?: string | null;
  PlanningStage?: string | null;
  ContractStageParent?: string | null;
  ContractStage?: string | null;
  ProjectStatus?: string | null;
  StartDate?: string | null;
  EndDate?: string | null;
  FirstPublished?: string | null;
  LatestEventDate?: string | null;
  SchemeDescription?: string | null;
  PlanningDescription?: string | null;
  Client?: string | null; // "Company Name~OfficeId"
  OfficeNames?: string | null; // "Company A~Company B~..."
  Website?: string | null;
  Funding?: string[] | null;
  RolesDetails?: GleniganRoleGroup[];
  RoleList?: GleniganRoleListEntry[];
}

interface GleniganResult {
  id?: string;
  source?: GleniganSource;
}

function formatDDMMYYYY(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

function buildTimeRange(since: Date, until: Date): string {
  return `From:${formatDDMMYYYY(since)} and To:${formatDDMMYYYY(until)}`;
}

/** "Company Name~OfficeId" or "A~B~C" -> first non-empty segment before '~'. */
function firstTildeSegment(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split('~')[0]?.trim();
  return first || null;
}

/** Walks RolesDetails to find the first contact with a name, if any role has one. */
function firstContact(row: GleniganSource): GleniganContact | null {
  for (const group of row.RolesDetails ?? []) {
    for (const role of group.Roles ?? []) {
      for (const company of role.CompaniesInRole ?? []) {
        const contact = (company.ContactsInCompanyInRole ?? []).find((c) => isPresent(c.KeyCard_FullContact));
        if (contact) return contact;
      }
    }
  }
  return null;
}

function firstRolePhone(row: GleniganSource): string | null {
  const entry = (row.RoleList ?? []).find(
    (r) => isPresent(r.KeyCard_ContractPhone1) && r.KeyCard_ContractPhone1 !== 'Not Available'
  );
  return entry?.KeyCard_ContractPhone1 ?? null;
}

async function getCredentials(override?: AdapterFetchParams['credentials']) {
  const base = await resolveCredentials('glenigan', 'GLENIGAN_API_KEY', 'GLENIGAN_BASE_URL', DEFAULT_BASE_URL);
  if (!override) return base;
  return {
    apiKey: override.apiKey?.trim() || base.apiKey,
    apiSecret: override.apiSecret?.trim() || base.apiSecret,
    username: override.username?.trim() || base.username,
    baseUrl: override.baseUrl?.trim() || base.baseUrl,
  };
}

export const gleniganAdapter: SourceAdapter = {
  sourceKey: 'glenigan',

  async isConfigured(): Promise<boolean> {
    const creds = await getCredentials();
    return Boolean(creds.apiKey && creds.baseUrl);
  },

  async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
    const creds = await getCredentials(params.credentials);
    if (!creds.apiKey || !creds.baseUrl) {
      throw new Error(
        'Glenigan adapter is not configured (set an API key in /settings or GLENIGAN_API_KEY / GLENIGAN_BASE_URL in .env.local).'
      );
    }
    const baseUrl = creds.baseUrl.replace(/\/$/, '');
    const pageSize = params.dryRun ? Math.min(params.pageSize ?? 5, MAX_PAGE_SIZE) : (params.pageSize ?? 100);
    // Glenigan's /project/newproject feed reflects NEW/updated project events,
    // which can be sparse day-to-day — default to a much wider lookback than
    // other sources (confirmed empirically: a 24h window is frequently empty,
    // a multi-month window reliably returns thousands of matches).
    const since = params.since ?? new Date(Date.now() - 180 * 86_400_000);
    const until = params.until ?? new Date();
    const timeRange = buildTimeRange(since, until);

    const results: GleniganResult[] = [];
    let page = params.page ?? 1;
    const maxPages = params.dryRun ? 1 : 200; // safety cap against runaway pagination

    for (let i = 0; i < maxPages && results.length < pageSize; i++) {
      const url = new URL(`${baseUrl}/project/newproject`);
      url.searchParams.set('key', creds.apiKey);
      url.searchParams.set('Page', String(page));
      url.searchParams.set('Size', String(MAX_PAGE_SIZE));
      url.searchParams.set('OrderBy', 'LatestEventDate,desc');
      url.searchParams.set('TimeRange', timeRange);

      const res = await fetchWithRetry(
        url.toString(),
        { headers: { Accept: 'application/json', 'User-Agent': 'EvercamSourceHub/1.0' } },
        { timeoutMs: 20_000 }
      );
      if (!res.ok) {
        throw new Error(`Glenigan request failed: HTTP ${res.status} ${res.statusText} (page ${page})`);
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new AdapterShapeError('Glenigan response was not valid JSON.');
      }

      const pageResults = extractResults(body);
      results.push(...pageResults);

      if (params.dryRun || pageResults.length < MAX_PAGE_SIZE) break; // short page = last page
      page += 1;
    }

    const filtered = results.filter((entry) => {
      const row = entry.source ?? {};
      if (params.sectors?.length) {
        const sectorText = [row.PrimarySectors, row.SecondarySectors].filter(Boolean).join(' ').toLowerCase();
        if (!params.sectors.some((s) => sectorText.includes(s.toLowerCase()))) return false;
      }
      if (params.regions?.length) {
        const regionText = [row.ProjectTown, row.ProjectCounty, row.ProjectRegion]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!params.regions.some((r) => regionText.includes(r.toLowerCase()))) return false;
      }
      if (params.minValue) {
        const valueGbp = typeof row.Value === 'number' ? row.Value * 1_000_000 : 0;
        if (valueGbp < params.minValue) return false;
      }
      if (params.keyword?.trim()) {
        const haystack = [row.Heading, row.PrimaryHeading, row.SchemeDescription, row.PlanningDescription]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(params.keyword.trim().toLowerCase())) return false;
      }
      return true;
    });

    return filtered.slice(0, pageSize) as unknown as RawProjectRecord[];
  },

  normalize(raw: RawProjectRecord): CanonicalProjectInsert {
    const entry = raw as unknown as GleniganResult;
    const row = entry.source ?? {};
    const extId = entry.id || row.ProjectId || '';

    const projectName = row.Heading || row.PrimaryHeading || row.ProjectName || row.SiteName || null;
    const sectorText = [row.PrimarySectors, row.SecondarySectors].filter(Boolean).join(', ') || null;
    const buildingType = row.Sectors?.[0]?.BuildingType || sectorText;
    const floorArea = row.FloorArea ?? row.Sectors?.[0]?.FloorArea ?? null;

    const addressLine =
      [row.AddressLine1, row.AddressLine2, row.AddressLine3].filter(Boolean).join(', ') || row.Address || null;
    const town = row.ProjectTown ?? null;
    const county = row.ProjectCounty ?? null;
    const region = row.ProjectRegion ?? null;

    const projectValue = typeof row.Value === 'number' ? Math.round(row.Value * 1_000_000) : null;
    const phase = row.PlanningStageParent || row.ContractStageParent || row.ProjectStatus || null;
    const description = row.SchemeDescription || row.PlanningDescription || null;
    const announced = row.FirstPublished || row.LatestEventDate || null;

    const companyName = firstTildeSegment(row.Client) || firstTildeSegment(row.OfficeNames);
    const contact = firstContact(row);
    const contactName = contact?.KeyCard_FullContact ?? null;
    const contactTitle = contact?.JobTitleForThisProject ?? null;
    const contactPhone = contact?.KeyCard_Phone1 ?? firstRolePhone(row);
    const fundingSource = row.Funding && row.Funding.length > 0 ? row.Funding.join(', ') : null;
    const companyWebsite = isPresent(row.Website) ? row.Website : null;

    const presentFields: Partial<Record<CriticalField, boolean>> = {
      project_name: isPresent(projectName),
      project_value: isPresent(projectValue),
      project_location: isPresent(town) || isPresent(county) || isPresent(region) || isPresent(addressLine),
      project_timeline: isPresent(row.StartDate) || isPresent(announced),
      building_type: isPresent(buildingType),
      company_name: isPresent(companyName),
      company_contact: isPresent(contactName),
      project_phase: isPresent(phase),
      square_footage: isPresent(floorArea),
      funding_source: isPresent(fundingSource),
      company_website: isPresent(companyWebsite),
      company_phone: isPresent(contactPhone),
    };

    const completeness = computeCompleteness(presentFields);

    return {
      canonical_name: projectName ?? `Glenigan project ${extId}`,
      source_key: 'glenigan',
      source_unique_id: String(extId),
      icp_code: 'tier1_gc',
      record_type: 'project',
      bu: 'uk',
      project_type: row.DevelopmentType || sectorText,
      building_type: buildingType,
      description,
      square_footage: typeof floorArea === 'number' ? floorArea : null,
      address_line1: addressLine,
      city: town,
      state_province: county || region,
      country: 'GB',
      country_code: 'GB',
      latitude: typeof row.ProjectLocation?.lat === 'number' ? row.ProjectLocation.lat : null,
      longitude: typeof row.ProjectLocation?.lon === 'number' ? row.ProjectLocation.lon : null,
      announced_date: normalizeDate(announced),
      construction_start_date: normalizeDate(row.StartDate),
      estimated_completion_date: normalizeDate(row.EndDate),
      current_phase: phase,
      estimated_value: projectValue,
      estimated_value_currency: projectValue !== null ? 'GBP' : null,
      company_name_raw: companyName,
      contact_name: contactName,
      contact_title: contactTitle,
      contact_email: null, // not exposed by this endpoint
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

function extractResults(data: unknown): GleniganResult[] {
  if (Array.isArray(data)) return data as GleniganResult[];
  const results = (data as { results?: unknown } | undefined)?.results;
  return Array.isArray(results) ? (results as GleniganResult[]) : [];
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
