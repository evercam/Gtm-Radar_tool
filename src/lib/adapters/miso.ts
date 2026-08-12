import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { computeCompleteness, isPresent } from '@/lib/completeness';

/**
 * The MISO generator interconnection queue — the earliest signal there is.
 *
 * A generator must apply to connect to the grid years before it breaks ground, so
 * every row here is a project that does not yet exist. Measured on the live feed:
 * 3,806 active requests, of which 592 have not started their study and 900 are in
 * Phase 1. Nothing in this queue is `too_late`, which is the entire reason it is
 * worth ingesting — the rest of the book skews to projects already under way.
 *
 * Keyless, one JSON call, no pagination:
 *   https://www.misoenergy.org/api/giqueue/getprojects
 *
 * MISO covers the US midwest and south — 12 states, led by MI, IL, IN, AR and LA.
 * That is all `usa` BU.
 *
 * WHAT THIS SOURCE DOES NOT GIVE YOU
 * ----------------------------------
 * The developer's name. `transmissionOwner` is the utility that owns the wires
 * ("ENTERGY MISSISSIPPI, LLC."), not whoever is building the solar farm, and MISO
 * does not publish the interconnection customer in this feed.
 *
 * That is a real limitation and it is handled honestly rather than papered over.
 * The utility goes in `company_name_raw` because it IS a company, it IS a real
 * Evercam prospect — somebody builds that substation — and a lead with a
 * contactable company beats one with none. But the description says plainly which
 * company it is, so a rep is never told the utility is the developer, and the
 * brief can go and find the actual customer once the project has a name and a
 * county.
 *
 * Compare NESO, which names the connection customer on every row and therefore
 * gives the developer directly. MISO is the weaker feed on identity and the
 * stronger one on volume and earliness.
 */

const ENDPOINT = 'https://www.misoenergy.org/api/giqueue/getprojects';

interface MisoRow {
  id?: number;
  projectNumber?: string;
  queueDate?: string | null;
  inService?: string | null;
  transmissionOwner?: string | null;
  county?: string | null;
  state?: string | null;
  studyPhase?: string | null;
  studyCycle?: string | null;
  studyGroup?: string | null;
  svcType?: string | null;
  poiName?: string | null;
  summerNetMW?: number | null;
  winterNetMW?: number | null;
  fuelType?: string | null;
  facilityType?: string | null;
  applicationStatus?: string | null;
  postGIAStatus?: string | null;
}

/**
 * MISO's fuel types, mapped to this app's vertical vocabulary.
 *
 * Observed across the live feed: Solar 1,764 · Battery Storage 736 · Wind 521 ·
 * Hybrid 372 · Gas 121 · Combined Cycle 9 · Nuclear 8 · Waste Heat Recovery 6,
 * plus 253 with the field blank.
 *
 * `Hybrid` is solar-plus-storage in almost every case in this queue, and it is
 * mapped to `battery` rather than `solar` because the storage half is the part
 * with a construction programme Evercam sells into.
 */
export function misoVerticalFor(fuelType: string | null | undefined): string {
  const f = (fuelType ?? '').toLowerCase();
  if (!f.trim()) return 'power';
  if (f.includes('solar')) return 'solar';
  if (f.includes('battery') || f.includes('storage') || f.includes('hybrid')) return 'battery';
  if (f.includes('wind')) return 'wind';
  if (f.includes('nuclear')) return 'nuclear';
  if (f.includes('hydro')) return 'hydro';
  if (f.includes('coal')) return 'coal';
  if (f.includes('gas') || f.includes('combined cycle') || f.includes('diesel')) return 'oil_gas';
  if (f.includes('waste') || f.includes('biomass') || f.includes('landfill')) return 'bioenergy';
  return 'power';
}

/**
 * The label written to `project_type`, so the generated `vertical` column agrees
 * with misoVerticalFor().
 *
 * This mapping exists because of a bug worth not repeating: the NESO adapter had a
 * working verticalFor() that nothing called, and 331 battery projects landed as
 * `other`. The classifier reads the label, so the label has to carry the vertical.
 */
const VERTICAL_LABEL: Record<string, string> = {
  solar: 'Solar farm',
  battery: 'Battery storage',
  wind: 'Wind farm',
  nuclear: 'Nuclear plant',
  hydro: 'Hydro plant',
  coal: 'Coal plant',
  oil_gas: 'Gas power plant',
  bioenergy: 'Bioenergy plant',
  power: 'Power plant',
};

/**
 * MISO study phases, ordered earliest first.
 *
 * Written to `current_phase` verbatim so the admin-editable phase table decides
 * the timing weight rather than this adapter. Listed here only so a reader knows
 * what arrives:
 *
 *   Study Not Started  592   the queue position exists, nothing has begun
 *   Phase 1            900
 *   Phase 2            510
 *   Phase 3            253
 *   GIA              1,145   agreement signed — the closest to a build
 */

const isoDate = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  /*
    MISO's `inService` is a target and occasionally lands decades out or in the
    past on a stale row. Fifty years either side is a parse artefact rather than a
    schedule, and a bad date is worse than none because arrivalFor believes it.
  */
  const years = Math.abs(t - Date.now()) / (365.25 * 86_400_000);
  return years > 50 ? null : new Date(t).toISOString().slice(0, 10);
};

export const misoQueueAdapter: SourceAdapter = {
  sourceKey: 'miso_interconnection_queue',

  async isConfigured(): Promise<boolean> {
    return true; // keyless
  },

  async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
    /*
      One call returns the whole queue — about 2.2 MB and 3,806 rows. There is no
      pagination and no date filter, so `maxRecords` is applied after the fetch
      rather than by asking for less.
    */
    const res = await fetchWithRetry(
      ENDPOINT,
      { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 Evercam Source Hub research@evercam.io' } },
      { timeoutMs: 45_000 }
    );
    if (!res.ok) throw new Error(`miso-queue: HTTP ${res.status} ${res.statusText}`);

    let rows: MisoRow[];
    try {
      rows = (await res.json()) as MisoRow[];
    } catch {
      throw new AdapterShapeError('miso-queue: response was not valid JSON.');
    }
    if (!Array.isArray(rows)) {
      throw new AdapterShapeError('miso-queue: expected a JSON array of queue requests.');
    }

    /*
      A row with no queue number cannot be deduplicated on a rerun, and one with no
      capacity is not a project worth a rep's time. Both are dropped rather than
      ingested and filtered later, so the source's record count means something.
    */
    const usable = rows.filter((r) => (r.projectNumber ?? '').trim() && (r.summerNetMW ?? 0) > 0);

    /*
      Newest applications first — a request filed this month is a better lead than
      one that has sat in the queue for four years.

      With a caveat found in the first dry run: the newest rows are also the
      SPARSEST. MISO backfills fuelType, studyPhase and county after the request is
      logged, so the six most recent all arrived with a blank fuel type, no phase
      and no county — landing as a generic "Power plant" at completeness tier D.

      Across the whole queue that is the minority (253 of 3,806 blank fuel, 406
      blank phase), and a full ingest takes everything regardless of order, so the
      sort only shapes what a capped or dry run sees. Left as newest-first because
      earliness is the reason this source exists; the thinness is a property of the
      feed, not something the sort should hide by burying recent rows.
    */
    usable.sort((a, b) => Date.parse(b.queueDate ?? '') - Date.parse(a.queueDate ?? '') || 0);

    const limit = params.dryRun ? Math.min(params.pageSize ?? 5, 50) : (params.maxRecords ?? 4000);
    return usable.slice(0, limit) as unknown as RawProjectRecord[];
  },

  normalize(raw: RawProjectRecord): CanonicalProjectInsert {
    const r = raw as unknown as MisoRow;

    const vertical = misoVerticalFor(r.fuelType);
    const label = VERTICAL_LABEL[vertical] ?? 'Power plant';
    const capacity = typeof r.summerNetMW === 'number' && r.summerNetMW > 0 ? r.summerNetMW : null;
    const county = (r.county ?? '').trim();
    const state = (r.state ?? '').trim();
    const utility = (r.transmissionOwner ?? '').trim();
    const phase = (r.studyPhase ?? '').trim();
    const queueNo = (r.projectNumber ?? '').trim();

    /*
      A queue request has no project name — it has a number. So the name is built
      from what identifies it to a human: the technology, where it is, and the
      queue number that makes it findable in MISO's own portal.
    */
    const place = [county, state].filter(Boolean).join(', ');
    const canonical_name = [label, place ? `— ${place}` : null, `(MISO ${queueNo})`].filter(Boolean).join(' ');

    /*
      What this feed can and cannot supply, stated per field rather than inferred.
      No value, no square footage and no contact — a queue request carries none of
      them — so the completeness score is honestly capped rather than flattered.
    */
    const completeness = computeCompleteness({
      project_name: isPresent(canonical_name),
      project_value: false,
      project_location: isPresent(place),
      // The in-service target is the only date that places this in time.
      project_timeline: isPresent(r.inService),
      building_type: isPresent(label),
      // The utility, not the developer — see the file header.
      company_name: isPresent(utility),
      company_contact: false,
      project_phase: isPresent(phase),
      square_footage: false,
      funding_source: false,
      company_website: false,
      company_phone: false,
    });

    return {
      canonical_name: canonical_name.slice(0, 300),
      source_key: 'miso_interconnection_queue',
      source_unique_id: queueNo,
      /*
        The interconnecting utility owns critical infrastructure, which is what the
        company on this record actually is. NOT tier1_gc — nobody here is a
        contractor, and claiming otherwise would misroute the pitch.
      */
      icp_code: 'critical_infra_owner',
      record_type: 'project',
      bu: 'usa',
      project_type: label,
      building_type: label,
      description: [
        `Grid interconnection request ${queueNo} in the MISO queue.`,
        capacity != null ? `${capacity} MW${r.winterNetMW && r.winterNetMW !== capacity ? ` summer / ${r.winterNetMW} MW winter` : ''}.` : null,
        phase ? `Study phase: ${phase}.` : null,
        r.studyCycle ? `Cycle ${r.studyCycle}${r.studyGroup ? `, ${r.studyGroup} group` : ''}.` : null,
        r.poiName ? `Point of interconnection: ${r.poiName}.` : null,
        /*
          Said explicitly. The company on this record is the wires owner, and a rep
          who assumes it is the developer will open the call wrong.
        */
        utility ? `Interconnecting utility: ${utility} — this is the transmission owner, not the project developer, which MISO does not publish.` : null,
        r.applicationStatus ? `Application status: ${r.applicationStatus}.` : null,
      ]
        .filter(Boolean)
        .join(' ')
        .slice(0, 1000),
      city: county || null,
      state_province: state || null,
      country: 'United States',
      country_code: 'US',
      // The date the request was filed — the earliest public moment of this project.
      announced_date: isoDate(r.queueDate),
      construction_start_date: null,
      estimated_completion_date: isoDate(r.inService),
      bid_date: null,
      project_url: 'https://www.misoenergy.org/planning/generator-interconnection/GI_Queue/',
      current_phase: phase || null,
      estimated_value: null,
      estimated_value_currency: null,
      capacity_mw: capacity,
      technology_type: (r.fuelType ?? '').trim() || null,
      company_name_raw: utility || null,
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
