import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import type { CriticalField } from '@/lib/supabase/types';

/**
 * Ireland National Planning Applications adapter (BU: ireland, ICP: developer).
 * Published on data.gov.ie as an Esri FeatureServer covering all Irish local
 * authorities — the developer signal for Ireland. KEYLESS.
 *
 * Verified live 2026-07-25:
 *   - GET .../IrishPlanningApplications/FeatureServer/0/query?f=json&where=&outFields=*
 *   - Response: { features: [ { attributes: {...} } ] }
 *   - Attributes: ApplicationNumber, DevelopmentDescription, DevelopmentAddress,
 *     ApplicationStatus, ApplicationType, ApplicantForename/Surname,
 *     ApplicantAddress, LandUseCode, AreaofSite, NumResidentialUnits, FloorArea,
 *     ReceivedDate/DecisionDate/GrantDate (epoch ms), PlanningAuthority,
 *     LinkAppDetails, OBJECTID.
 */

const DEFAULT_BASE_URL =
  'https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0/query';

interface IePlanningAttrs {
  OBJECTID?: number;
  PlanningAuthority?: string | null;
  ApplicationNumber?: string | null;
  DevelopmentDescription?: string | null;
  DevelopmentAddress?: string | null;
  DevelopmentPostcode?: string | null;
  ApplicationStatus?: string | null;
  ApplicationType?: string | null;
  ApplicantForename?: string | null;
  ApplicantSurname?: string | null;
  ApplicantAddress?: string | null;
  LandUseCode?: string | null;
  AreaofSite?: number | null;
  NumResidentialUnits?: number | null;
  FloorArea?: number | null;
  ReceivedDate?: number | null;
  DecisionDate?: number | null;
  GrantDate?: number | null;
  LinkAppDetails?: string | null;
}
interface IeFeature {
  attributes?: IePlanningAttrs;
}
interface IeResponse {
  features?: IeFeature[];
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

export const planningIeAdapter: SourceAdapter = {
  sourceKey: 'planning_ie',

  async isConfigured(): Promise<boolean> {
    return true; // keyless
  },

  async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
    const baseUrl = params.credentials?.baseUrl?.trim() || process.env.PLANNING_IE_BASE_URL || DEFAULT_BASE_URL;
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

    // Server-side WHERE clause (keyword + region); dates filtered client-side.
    const clauses = ['1=1'];
    if (params.keyword?.trim()) {
      const kw = esc(params.keyword.trim().toUpperCase());
      clauses.push(`(UPPER(DevelopmentDescription) LIKE '%${kw}%' OR UPPER(DevelopmentAddress) LIKE '%${kw}%')`);
    }
    if (params.regions?.length) {
      const list = params.regions.map((r) => `'${esc(r)}'`).join(',');
      clauses.push(`PlanningAuthority IN (${list})`);
    }
    const where = clauses.join(' AND ');

    const sinceT = params.since ? params.since.getTime() : -Infinity;
    const untilT = params.until ? params.until.getTime() : Infinity;

    const results: IePlanningAttrs[] = [];
    let offset = ((params.page ?? 1) - 1) * pageSize;
    // Enough pages to reach the budget, with a hard ceiling so a misconfigured
    // budget cannot walk a vendor’s whole index.
    const maxPages = params.dryRun ? 1 : Math.min(200, Math.max(1, Math.ceil(maxRecords / Math.max(1, Math.min(pageSize, 2_000))) + 2));

    for (let i = 0; i < maxPages && results.length < maxRecords; i++) {
      const url = new URL(baseUrl);
      url.searchParams.set('f', 'json');
      url.searchParams.set('where', where);
      url.searchParams.set('outFields', '*');
      url.searchParams.set('returnGeometry', 'false');
      url.searchParams.set('orderByFields', 'ReceivedDate DESC');
      // The ArcGIS layer declares maxRecordCount 2000 in its own metadata. 200 was a
      // guess, and this service holds over half a million applications.
      url.searchParams.set('resultRecordCount', String(Math.min(pageSize, 2_000)));
      url.searchParams.set('resultOffset', String(offset));

      const res = await fetchWithRetry(
        url.toString(),
        { headers: { Accept: 'application/json', 'User-Agent': 'EvercamSourceHub/1.0' } },
        { timeoutMs: 20_000 }
      );
      if (!res.ok) {
        throw new Error(`Ireland planning request failed: HTTP ${res.status} ${res.statusText}`);
      }
      let body: IeResponse;
      try {
        body = (await res.json()) as IeResponse;
      } catch {
        throw new AdapterShapeError('Ireland planning response was not valid JSON.');
      }
      const feats = body.features;
      if (!Array.isArray(feats)) {
        throw new AdapterShapeError('Ireland planning response had no features array.');
      }
      const page = feats.map((f) => f.attributes ?? {});
      // Client-side date filter on ReceivedDate (epoch ms).
      for (const a of page) {
        const t = typeof a.ReceivedDate === 'number' ? a.ReceivedDate : NaN;
        if (Number.isNaN(t) || (t >= sinceT && t <= untilT)) results.push(a);
      }
      if (params.dryRun || page.length < Math.min(pageSize, 2_000)) break;
      offset += page.length;
    }

    return results.slice(0, maxRecords) as unknown as RawProjectRecord[];
  },

  normalize(raw: RawProjectRecord): CanonicalProjectInsert {
    const a = raw as unknown as IePlanningAttrs;
    const appNo = a.ApplicationNumber ?? '';
    const authority = a.PlanningAuthority ?? '';
    const extId = `${appNo}|${authority}` !== '|' ? `${appNo}|${authority}` : String(a.OBJECTID ?? '');

    const desc = a.DevelopmentDescription ?? null;
    const applicant = [a.ApplicantForename, a.ApplicantSurname].filter(Boolean).join(' ').trim() || null;
    const building = a.LandUseCode || a.ApplicationType || null;
    const floor = typeof a.FloorArea === 'number' ? a.FloorArea : null;
    const address = a.DevelopmentAddress ?? null;

    const presentFields: Partial<Record<CriticalField, boolean>> = {
      project_name: isPresent(desc),
      project_value: false,
      project_location: isPresent(address) || isPresent(authority),
      project_timeline: isPresent(a.ReceivedDate),
      building_type: isPresent(building),
      company_name: isPresent(applicant),
      company_contact: isPresent(applicant), // applicant is a named person/entity
      project_phase: isPresent(a.ApplicationStatus),
      square_footage: floor != null,
      funding_source: false,
      company_website: false,
      company_phone: false,
    };

    const completeness = computeCompleteness(presentFields);

    return {
      canonical_name: desc?.slice(0, 300) || `Irish planning application ${appNo || extId}`,
      source_key: 'planning_ie',
      source_unique_id: extId,
      icp_code: 'developer',
      record_type: 'permit',
      bu: 'ireland',
      project_type: a.ApplicationType ?? null,
      building_type: building,
      description:
        [desc, a.NumResidentialUnits ? `${a.NumResidentialUnits} residential units` : null]
          .filter(Boolean)
          .join(' — ')
          .slice(0, 1000) || null,
      square_footage: floor,
      address_line1: address,
      city: null,
      state_province: authority || null,
      country: 'IE',
      country_code: 'IE',
      announced_date: msToDate(a.ReceivedDate),
      construction_start_date: null,
      estimated_completion_date: null,
      bid_date: null,
      project_url: a.LinkAppDetails ?? null,
      current_phase: a.ApplicationStatus ?? null,
      estimated_value: null,
      estimated_value_currency: null,
      company_name_raw: applicant,
      contact_name: applicant,
      contact_title: 'Applicant',
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

function msToDate(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
