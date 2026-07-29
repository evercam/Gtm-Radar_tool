import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import type { CriticalField } from '@/lib/supabase/types';

/**
 * World Bank Projects adapter (BU: export, ICP: critical_infra_owner) — the
 * canonical global major-projects feed for the Export / Major Projects business:
 * mission-critical, cross-region development and infrastructure projects
 * (energy, transport, water, health, urban). KEYLESS.
 *
 * Verified live 2026-07-25:
 *   - GET https://search.worldbank.org/api/v3/projects?format=json&fl=...&rows=&os=
 *   - Response: { total, projects: { "<id>": {...}, ... } } (object keyed by id).
 *   - Fields: id, project_name, countryname, countrycode, regionname, totalamt,
 *     boardapprovaldate, closingdate, status, project_abstract, borrower,
 *     impagency, major_sectors.
 *
 * The public API exposes the borrower + implementing agency (the account) and
 * the funding institution, but no personal contacts — enrichment (Claude +
 * Apollo) resolves decision-makers from the identified agency.
 */

const DEFAULT_BASE_URL = 'https://search.worldbank.org/api/v3/projects';
const FL = [
  'id',
  'project_name',
  'countryname',
  'countrycode',
  'regionname',
  'totalamt',
  'boardapprovaldate',
  'closingdate',
  'status',
  'project_abstract',
  'borrower',
  'impagency',
  'major_sectors',
].join(',');

interface WbMajorSector {
  major_sector?: { major_sector_name?: string };
}
interface WbProject {
  id?: string;
  project_name?: string;
  countryname?: string;
  countrycode?: string | string[];
  regionname?: string;
  totalamt?: string;
  boardapprovaldate?: string;
  closingdate?: string;
  status?: string;
  project_abstract?: string | { cdata?: string };
  borrower?: string;
  impagency?: string;
  major_sectors?: WbMajorSector[] | string;
}
interface WbResponse {
  total?: number;
  projects?: Record<string, WbProject>;
}

function abstractText(a: WbProject['project_abstract']): string | null {
  if (!a) return null;
  if (typeof a === 'string') return a;
  return a.cdata ?? null;
}

function sectorText(s: WbProject['major_sectors']): string | null {
  if (!s) return null;
  if (typeof s === 'string') return s;
  const names = Array.from(new Set(s.map((x) => x.major_sector?.major_sector_name).filter(Boolean)));
  return names.length ? names.join(', ') : null;
}

/** WB countrycode may be a string or a string[] ("PH" / ["PH"]) -> ISO-2. */
function iso2(code: string | string[] | undefined): string | null {
  const raw = Array.isArray(code) ? code[0] : code;
  if (!raw || typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  return c.length >= 2 ? c.slice(0, 2) : null;
}

export const worldBankAdapter: SourceAdapter = {
  sourceKey: 'world_bank',

  async isConfigured(): Promise<boolean> {
    return true; // keyless
  },

  async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
    const baseUrl = (
      params.credentials?.baseUrl?.trim() ||
      process.env.WORLD_BANK_BASE_URL ||
      DEFAULT_BASE_URL
    ).replace(/\/$/, '');
    const pageSize = params.dryRun ? Math.min(params.pageSize ?? 5, 50) : (params.pageSize ?? 100);

    // Fetch full 100-row pages and keep paginating until enough survive the
    // client-side value filter (fetching only `pageSize` rows then filtering
    // can zero out a small page).
    const rowsPerPage = params.dryRun ? Math.min(pageSize, 20) : 100;
    const passesValue = (p: WbProject) => {
      if (!params.minValue) return true;
      const amt = Number(p.totalamt ?? '0');
      return !Number.isNaN(amt) && amt >= params.minValue;
    };

    const filtered: WbProject[] = [];
    let offset = ((params.page ?? 1) - 1) * pageSize;
    const maxPages = params.dryRun ? 1 : 20;

    for (let i = 0; i < maxPages && filtered.length < pageSize; i++) {
      const url = new URL(baseUrl);
      url.searchParams.set('format', 'json');
      url.searchParams.set('fl', FL);
      url.searchParams.set('rows', String(rowsPerPage));
      url.searchParams.set('os', String(offset));
      url.searchParams.set('order', 'desc');
      url.searchParams.set('sort', 'boardapprovaldate');
      // Server-side filters the WB API supports.
      if (params.keyword?.trim()) url.searchParams.set('qterm', params.keyword.trim());
      if (params.regions?.length) url.searchParams.set('regionname_exact', params.regions.join('^'));
      if (params.since) url.searchParams.set('boardapprovaldate', `[${params.since.toISOString()} TO *]`);

      const res = await fetchWithRetry(
        url.toString(),
        { headers: { Accept: 'application/json', 'User-Agent': 'EvercamSourceHub/1.0' } },
        { timeoutMs: 20_000 }
      );
      if (!res.ok) {
        throw new Error(`World Bank request failed: HTTP ${res.status} ${res.statusText}`);
      }
      let body: WbResponse;
      try {
        body = (await res.json()) as WbResponse;
      } catch {
        throw new AdapterShapeError('World Bank response was not valid JSON.');
      }
      const map = body.projects;
      if (!map || typeof map !== 'object') {
        throw new AdapterShapeError('World Bank response had no projects object.');
      }
      const page = Object.values(map);
      filtered.push(...page.filter(passesValue));
      if (params.dryRun || page.length < rowsPerPage) break;
      offset += page.length;
    }

    return filtered.slice(0, pageSize) as unknown as RawProjectRecord[];
  },

  normalize(raw: RawProjectRecord): CanonicalProjectInsert {
    const p = raw as unknown as WbProject;
    const extId = String(p.id ?? '');
    const projectName = p.project_name ?? null;
    const building = sectorText(p.major_sectors);
    const value = p.totalamt && !Number.isNaN(Number(p.totalamt)) ? Number(p.totalamt) : null;
    // Account = the borrowing government / implementing agency (public owner).
    const companyName = p.impagency?.trim() || p.borrower?.trim() || null;
    const country = p.countryname ?? null;

    const presentFields: Partial<Record<CriticalField, boolean>> = {
      project_name: isPresent(projectName),
      project_value: value != null,
      project_location: isPresent(country) || isPresent(p.regionname),
      project_timeline: isPresent(p.boardapprovaldate) || isPresent(p.closingdate),
      building_type: isPresent(building),
      company_name: isPresent(companyName),
      company_contact: false, // no personal contacts on the public API
      project_phase: isPresent(p.status),
      square_footage: false,
      funding_source: true, // World Bank financed
      company_website: false,
      company_phone: false,
    };

    const completeness = computeCompleteness(presentFields);

    return {
      canonical_name: projectName ?? `World Bank project ${extId}`,
      source_key: 'world_bank',
      source_unique_id: extId,
      icp_code: 'critical_infra_owner',
      record_type: 'project',
      bu: 'export',
      project_type: building,
      building_type: building,
      description: abstractText(p.project_abstract)?.slice(0, 1000) ?? null,
      address_line1: null,
      city: null,
      state_province: p.regionname ?? null,
      country,
      country_code: iso2(p.countrycode),
      announced_date: normalizeDate(p.boardapprovaldate),
      construction_start_date: normalizeDate(p.boardapprovaldate),
      estimated_completion_date: normalizeDate(p.closingdate),
      bid_date: null,
      project_url: extId ? `https://projects.worldbank.org/en/projects-operations/project-detail/${extId}` : null,
      current_phase: p.status ?? null,
      estimated_value: value,
      estimated_value_currency: value != null ? 'USD' : null,
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
  const m = value.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
