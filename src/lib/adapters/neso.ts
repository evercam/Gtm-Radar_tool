import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import type { CriticalField } from '@/lib/supabase/types';

/**
 * The GB grid connection queue — every large energy project, with its developer.
 *
 * NESO (the national electricity system operator) publishes the registers of who
 * has asked to connect to the transmission network, at what capacity, and when.
 * Keyless, over a CKAN datastore API.
 *
 * This is here because it answers the question the UK planning feeds could not.
 * PlanIt carries 48,000 applications a month and names the APPLICANT — the
 * developer — on 1 record in 200; the other names it gives are planning
 * consultants, which is the wrong company to hand a rep. The TEC register names
 * the customer on 2,212 of 2,212 rows, and the customer IS the developer:
 * Hornsea Project Three, East Anglia Three, Eggborough Power, Thorpe Marsh Green
 * Energy Hub.
 *
 * What arrives with each project: a real name, a named developer, capacity in MW,
 * the connection date, the consent status, and the technology. No contact — these
 * are companies, and finding the people is what enrichment is for.
 *
 * Everything is ingested rather than pre-filtered to the near-term set. The
 * register runs to 2039 and timing is the heaviest weight in scoring, so a
 * scoping project connecting in 2037 sorts itself to the bottom without anybody
 * choosing a cutoff here. 243 of the current rows are consented or building with
 * a connection inside five years, which is the set that will surface on its own.
 */

const BASE = 'https://api.neso.energy/api/3/action/datastore_search';

export interface NesoRegisterConfig {
  slug: string;
  sourceKey: string;
  /** CKAN resource id — the register's queryable table. */
  resourceId: string;
  label: string;
}

export const NESO_REGISTERS: NesoRegisterConfig[] = [
  {
    slug: 'neso-tec',
    sourceKey: 'neso_tec_register',
    resourceId: '17becbab-e3e8-473f-b303-3806f43a6a10',
    label: 'Transmission Entry Capacity (TEC) register',
  },
  {
    // Distribution-connected projects: smaller, more numerous, same shape.
    slug: 'neso-embedded',
    sourceKey: 'neso_embedded_register',
    resourceId: '68b6f3a1-e1bf-403b-9062-0269fc758d77',
    label: 'Embedded register',
  },
];

/** One row of a register, as CKAN returns it. Column names carry spaces. */
interface NesoRow extends Record<string, unknown> {
  'Project Name'?: string;
  'Customer Name'?: string;
  'Connection Site'?: string;
  'Project Status'?: string;
  'Plant Type'?: string;
  'MW Effective From'?: string;
  'Cumulative Total Capacity (MW)'?: string | number;
  'MW Connected'?: string | number;
  'Project Number'?: string;
  'Project ID'?: string;
  'HOST TO'?: string;
  'Agreement Type'?: string;
}

/**
 * Technology to the tool's vertical.
 *
 * `Plant Type` is a semicolon-joined list — "Energy Storage System;PV Array
 * (Photo Voltaic/solar);Wind Onshore" is one project with three technologies —
 * so the most specific wins rather than the first listed. Storage is checked
 * last precisely because it accompanies almost everything: 737 rows are storage
 * alone, and another 600-odd pair it with solar or wind, where the wind or solar
 * is the thing being built.
 */
function verticalFor(plantType: string | undefined): string {
  const t = (plantType ?? '').toLowerCase();
  if (t.includes('nuclear')) return 'nuclear';
  if (t.includes('wind')) return 'wind';
  if (t.includes('pv') || t.includes('solar')) return 'solar';
  if (t.includes('hydro') || t.includes('pumped')) return 'hydro';
  if (t.includes('biomass') || t.includes('energy from waste')) return 'bioenergy';
  if (t.includes('ccgt') || t.includes('ocgt') || t.includes('gas')) return 'oil_gas';
  if (t.includes('coal')) return 'coal';
  if (t.includes('storage') || t.includes('battery') || t.includes('bess')) return 'battery';
  return 'power';
}

/**
 * The label `building_type` must carry so the generated `vertical` column agrees
 * with us.
 *
 * `vertical` is derived in SQL from the TEXT of building_type, and the register's
 * own wording does not survive that: "Energy Storage System" contains no word the
 * classifier knows, so 331 battery projects landed as `other` on the first
 * ingest. Computing the vertical here and then handing over raw text that
 * disagrees with it is the kind of half-fix that looks done.
 *
 * The raw `Plant Type` is not lost — it stays in `technology_type` and in the
 * description, which is where the semicolon list belongs.
 */
const VERTICAL_LABEL: Record<string, string> = {
  battery: 'Battery energy storage',
  solar: 'Solar generation',
  wind: 'Wind generation',
  hydro: 'Hydro generation',
  nuclear: 'Nuclear generation',
  bioenergy: 'Bioenergy generation',
  oil_gas: 'Gas-fired generation',
  coal: 'Coal generation',
  power: 'Power generation',
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : null;
};

/** ISO date, or null. The register uses YYYY-MM-DD already. */
function isoDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function makeNesoAdapter(cfg: NesoRegisterConfig): SourceAdapter {
  return {
    sourceKey: cfg.sourceKey,

    async isConfigured(): Promise<boolean> {
      return true; // keyless
    },

    async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
      const pageSize = params.dryRun ? Math.min(params.pageSize ?? 5, 100) : Math.min(params.pageSize ?? 1000, 1000);
      const maxRecords = params.dryRun ? pageSize : (params.maxRecords ?? 3000);

      const rows: NesoRow[] = [];
      for (let offset = 0; rows.length < maxRecords; offset += pageSize) {
        const url = `${BASE}?resource_id=${cfg.resourceId}&limit=${pageSize}&offset=${offset}`;
        const res = await fetchWithRetry(
          url,
          { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 Evercam Source Hub research@evercam.io' } },
          { timeoutMs: 30_000 }
        );
        if (!res.ok) throw new Error(`${cfg.slug}: HTTP ${res.status} ${res.statusText}`);

        let body: { success?: boolean; result?: { records?: NesoRow[]; total?: number } };
        try {
          body = (await res.json()) as typeof body;
        } catch {
          throw new AdapterShapeError(`${cfg.slug}: response was not valid JSON.`);
        }
        if (!body.success || !Array.isArray(body.result?.records)) {
          throw new AdapterShapeError(`${cfg.slug}: no result.records in the CKAN response.`);
        }

        const batch = body.result.records;
        if (batch.length === 0) break;
        rows.push(...batch);
        if (params.dryRun) break;
        if (batch.length < pageSize) break;
      }

      /*
        A row with no project name and no customer is not a project. The register
        is clean today — 2,212 of 2,212 name a customer — but a blank would
        otherwise become a record with nothing to call.
      */
      let kept = rows.filter((r) => (r['Project Name'] ?? '').trim() || (r['Customer Name'] ?? '').trim());

      if (params.keyword?.trim()) {
        const kw = params.keyword.trim().toLowerCase();
        kept = kept.filter((r) =>
          [r['Project Name'], r['Customer Name'], r['Plant Type'], r['Connection Site']]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(kw)
        );
      }
      if (params.minValue) {
        // No money in this register, so a value filter reads as megawatts —
        // the only scale it publishes.
        kept = kept.filter((r) => (num(r['Cumulative Total Capacity (MW)']) ?? 0) >= params.minValue!);
      }

      return kept.slice(0, maxRecords) as unknown as RawProjectRecord[];
    },

    normalize(raw: RawProjectRecord): CanonicalProjectInsert {
      const r = raw as NesoRow;
      const project = (r['Project Name'] ?? '').trim();
      const customer = (r['Customer Name'] ?? '').trim();
      const capacity = num(r['Cumulative Total Capacity (MW)']);
      const plant = (r['Plant Type'] ?? '').trim();
      const site = (r['Connection Site'] ?? '').trim();
      const status = (r['Project Status'] ?? '').trim();
      const label = VERTICAL_LABEL[verticalFor(plant)] ?? 'Power generation';

      /*
        The connection date is when power must flow, so it is a COMPLETION date,
        not a start. Putting it in construction_start_date would make every
        project look years further out than it is — and timing is the heaviest
        weight in scoring, so that error would bury the whole source.
      */
      const connection = isoDate(r['MW Effective From']);

      const externalId = String(r['Project Number'] ?? r['Project ID'] ?? `${customer}|${project}`).trim();

      const presentFields: Partial<Record<CriticalField, boolean>> = {
        project_name: isPresent(project),
        project_value: false, // the register publishes megawatts, not money
        project_location: isPresent(site),
        project_timeline: isPresent(connection),
        building_type: isPresent(label),
        company_name: isPresent(customer),
        company_contact: false,
        project_phase: isPresent(status),
        square_footage: false,
        funding_source: false,
        company_website: false,
        company_phone: false,
      };
      const completeness = computeCompleteness(presentFields);

      return {
        canonical_name: (project || `${customer} grid connection`).slice(0, 300),
        source_key: cfg.sourceKey,
        source_unique_id: externalId,
        // The customer holds the connection agreement, so they own the asset.
        icp_code: 'critical_infra_owner',
        record_type: 'project',
        bu: 'uk',
        // The mapped label, so the generated `vertical` column agrees with
        // verticalFor(). The register's own wording goes to technology_type.
        project_type: label,
        building_type: label,
        description: [
          site ? `Connecting at ${site}.` : null,
          capacity != null ? `${capacity} MW.` : null,
          status ? `Status: ${status}.` : null,
          r['HOST TO'] ? `Transmission owner: ${r['HOST TO']}.` : null,
          r['Agreement Type'] ? `${r['Agreement Type']} agreement.` : null,
          `From the NESO ${cfg.label}.`,
        ]
          .filter(Boolean)
          .join(' ')
          .slice(0, 1000),
        city: null,
        state_province: null,
        country: 'United Kingdom',
        country_code: 'GB',
        announced_date: null,
        construction_start_date: null,
        estimated_completion_date: connection,
        bid_date: null,
        project_url: 'https://www.neso.energy/data-portal',
        current_phase: status || null,
        estimated_value: null,
        estimated_value_currency: null,
        // Megawatts, which is exactly what this column is for.
        capacity_mw: capacity,
        technology_type: plant || null,
        company_name_raw: customer || null,
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
}

function register(slug: string): NesoRegisterConfig {
  const found = NESO_REGISTERS.find((r) => r.slug === slug);
  if (!found) throw new Error(`No NESO register configured for "${slug}".`);
  return found;
}

// By slug, never by index — see the note on the OCDS adapters for what happens
// when a config is inserted in the middle of a positionally-indexed list.
export const nesoTecAdapter = makeNesoAdapter(register('neso-tec'));
export const nesoEmbeddedAdapter = makeNesoAdapter(register('neso-embedded'));
export { verticalFor as nesoVerticalFor };
