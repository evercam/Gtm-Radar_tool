import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import type { CriticalField, BusinessUnit } from '@/lib/supabase/types';

/**
 * Generic Open Contracting Data Standard (OCDS) adapter factory. Powers two
 * KEYLESS, live-verified government procurement publishers:
 *   - Find a Tender UK  (find-tender.service.gov.uk) — UK, ICP critical_infra_owner
 *   - AusTender         (api.tenders.gov.au)         — APAC/Australia, ICP critical_infra_owner
 *
 * Both return an OCDS release package: { releases: [ { ocid, date, parties[],
 * tender, awards[], contracts[], buyer? } ], links: { next } }. Field
 * locations differ slightly between publishers, so the extractors below probe
 * several OCDS locations (parties-by-role, top-level buyer, tender/award/
 * contract value). Verified live 2026-07-24.
 */

interface OcdsValue {
  amount?: number;
  currency?: string;
}
interface OcdsAddress {
  locality?: string;
  region?: string;
  countryName?: string;
}
interface OcdsContactPoint {
  name?: string;
  telephone?: string;
  email?: string;
}
interface OcdsParty {
  name?: string;
  roles?: string[];
  address?: OcdsAddress;
  contactPoint?: OcdsContactPoint;
}
interface OcdsClassification {
  scheme?: string;
  id?: string;
  description?: string;
}
interface OcdsItem {
  classification?: OcdsClassification;
}
interface OcdsTender {
  id?: string;
  title?: string;
  description?: string;
  value?: OcdsValue;
  items?: OcdsItem[];
}
interface OcdsAward {
  title?: string;
  description?: string;
  value?: OcdsValue;
  date?: string;
}
interface OcdsContract {
  title?: string;
  description?: string;
  value?: OcdsValue;
  dateSigned?: string;
  items?: OcdsItem[];
  period?: { startDate?: string; endDate?: string };
}
interface OcdsRelease {
  ocid?: string;
  id?: string;
  date?: string;
  parties?: OcdsParty[];
  buyer?: { name?: string };
  tender?: OcdsTender;
  awards?: OcdsAward[];
  contracts?: OcdsContract[];
}
interface OcdsPackage {
  releases?: OcdsRelease[];
  links?: { next?: string };
}

export interface OcdsPublisherConfig {
  slug: string; // URL slug used by /api/search & /api/ingest
  sourceKey: string; // source_registry.source_key
  icpCode: string;
  bu: BusinessUnit;
  countryCode: string; // ISO-2 fallback for records with no party address
  /** Format a Date into the datetime string this publisher's API expects. */
  fmtDate: (d: Date, edge: 'from' | 'to') => string;
  /** Build the first-page URL for a date window (already-formatted strings). */
  buildUrl: (from: string, to: string, stage?: string) => string;
  /** Whether this publisher understands the `stages` parameter. */
  supportsStages?: boolean;
}

// Find a Tender: "YYYY-MM-DDT00:00:00" — NO trailing Z (a Z 400s / returns empty).
function fmtNoZ(d: Date, edge: 'from' | 'to'): string {
  return `${d.toISOString().slice(0, 10)}T${edge === 'from' ? '00:00:00' : '23:59:59'}`;
}
// AusTender: full ISO-8601 with Z (path segments).
function fmtZulu(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const OCDS_PUBLISHERS: OcdsPublisherConfig[] = [
  {
    slug: 'find-a-tender',
    sourceKey: 'find_a_tender_uk',
    icpCode: 'critical_infra_owner',
    bu: 'uk',
    countryCode: 'GB',
    fmtDate: fmtNoZ,
    supportsStages: true,
    // One stage at a time: the API accepts "tender,award" and answers with an
    // empty list rather than an error, so a comma list looks like "no results"
    // instead of "unsupported". Omitting the parameter returns every stage.
    buildUrl: (from, to, stage) =>
      `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?updatedFrom=${from}&updatedTo=${to}` +
      `${stage ? `&stages=${stage}` : ''}&limit=100`,
  },
  {
    slug: 'austender',
    sourceKey: 'austender',
    icpCode: 'critical_infra_owner',
    bu: 'apac',
    countryCode: 'AU',
    fmtDate: (d) => fmtZulu(d),
    buildUrl: (from, to) => `https://api.tenders.gov.au/ocds/findByDates/contractPublished/${from}/${to}`,
  },
  {
    // UK sub-threshold public contracts — rich buyer contactPoint (name + email
    // + phone), verified live. High lead-actionability.
    slug: 'contracts-finder',
    sourceKey: 'contracts_finder_uk',
    icpCode: 'critical_infra_owner',
    bu: 'uk',
    countryCode: 'GB',
    fmtDate: fmtNoZ,
    supportsStages: true,
    buildUrl: (from, to, stage) =>
      `https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?publishedFrom=${from}&publishedTo=${to}` +
      `${stage ? `&stages=${stage}` : ''}`,
  },
];

function firstValue(...vals: (OcdsValue | undefined)[]): OcdsValue | null {
  for (const v of vals) if (v && typeof v.amount === 'number') return v;
  return null;
}

// --- construction scoping ----------------------------------------------------
// CPV (UK/EU) construction: 45* = construction works, 71* = architectural/
// engineering/inspection services. UNSPSC (AusTender) construction: 72* =
// building & facility construction/maintenance, 95* = land & structures, 30* =
// structural materials, 81101* = professional engineering.
const CPV_CONSTRUCTION_PREFIXES = ['45', '71'];
const UNSPSC_CONSTRUCTION_PREFIXES = ['72', '95', '30', '81101'];
const CONSTRUCTION_KEYWORDS =
  /\b(construction|constructing|refurbish|refurbishment|renovation|demolition|civil engineer|infrastructure|roadworks?|highway|bridge works?|structural (?:steel|works)|fit[-\s]?out|new build|earthworks?|groundworks?|piling|cladding|re-?roof|roofing|building works?|redevelopment|data cent(?:re|er)|main contractor|design and build)\b/i;

function releaseClassifications(r: OcdsRelease): OcdsClassification[] {
  const out: OcdsClassification[] = [];
  for (const it of r.tender?.items ?? []) if (it.classification) out.push(it.classification);
  for (const c of r.contracts ?? []) for (const it of c.items ?? []) if (it.classification) out.push(it.classification);
  return out;
}

/** True if a release looks like construction/engineering work. Classification
 *  codes are the reliable signal (present on most UK/AU notices); human text is
 *  the fallback for notices published without an itemized classification. */
function isConstructionRelease(r: OcdsRelease): boolean {
  const classes = releaseClassifications(r);
  for (const c of classes) {
    const id = (c.id ?? '').replace(/\D/g, '');
    if (!id) continue;
    const scheme = (c.scheme ?? '').toUpperCase();
    const prefixes = scheme.includes('UNSPSC') ? UNSPSC_CONSTRUCTION_PREFIXES : CPV_CONSTRUCTION_PREFIXES;
    if (prefixes.some((p) => id.startsWith(p))) return true;
  }
  const contract = r.contracts?.[0];
  const award = r.awards?.[0];
  const text = [
    r.tender?.title,
    r.tender?.description,
    contract?.title,
    contract?.description,
    award?.title,
    award?.description,
    ...classes.map((c) => c.description),
  ]
    .filter(Boolean)
    .join(' ');
  return CONSTRUCTION_KEYWORDS.test(text);
}

function partyByRole(parties: OcdsParty[] | undefined, role: string): OcdsParty | null {
  return (parties ?? []).find((p) => (p.roles ?? []).includes(role)) ?? null;
}

function hasContact(cp: OcdsContactPoint | undefined): boolean {
  return Boolean(cp && (cp.name || cp.email || cp.telephone));
}

/**
 * Best contact across all parties for lead-actionability: prefer the buyer/
 * procuring entity's contact, then any party that carries a name/email/phone.
 */
function bestContact(parties: OcdsParty[] | undefined): OcdsContactPoint | null {
  const list = parties ?? [];
  const preferred = ['procuringEntity', 'buyer'];
  for (const role of preferred) {
    const p = list.find((x) => (x.roles ?? []).includes(role) && hasContact(x.contactPoint));
    if (p) return p.contactPoint!;
  }
  const any = list.find((x) => hasContact(x.contactPoint));
  return any?.contactPoint ?? null;
}

/** The publisher's own explanation of a failure, appended to the status line. */
async function detail(res: Response): Promise<string> {
  try {
    const body = (await res.text()).slice(0, 500);
    if (!body) return '';
    try {
      const j = JSON.parse(body) as { message?: string; error?: string; detail?: string };
      const msg = j.message ?? j.detail ?? j.error;
      if (msg) return ` — ${msg}`;
    } catch {
      // not JSON; fall through to the raw body
    }
    return ` — ${body.replace(/\s+/g, ' ').trim()}`;
  } catch {
    return '';
  }
}

function makeOcdsAdapter(cfg: OcdsPublisherConfig): SourceAdapter {
  return {
    sourceKey: cfg.sourceKey,

    async isConfigured(): Promise<boolean> {
      return true; // keyless
    },

    async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
      const pageSize = params.dryRun ? Math.min(params.pageSize ?? 5, 100) : (params.pageSize ?? 100);
      const now = new Date();
      const from = params.since ?? new Date(now.getTime() - 90 * 86_400_000);
      const to = params.until ?? now;

      // Strictly after, not equal: a same-day window is legitimate and common
      // — `from` is formatted to 00:00:00 and `to` to 23:59:59, so it spans a
      // real day. Rejecting equality would refuse every "just today" search.
      if (from.getTime() > to.getTime()) {
        throw new Error(
          `${cfg.slug}: the "since" date (${from.toISOString().slice(0, 10)}) must not be after "until" ` +
            `(${to.toISOString().slice(0, 10)}). Swap them and search again.`
        );
      }

      const releases: OcdsRelease[] = [];
      const stage = cfg.supportsStages ? params.stage : undefined;
      let url: string | undefined = cfg.buildUrl(cfg.fmtDate(from, 'from'), cfg.fmtDate(to, 'to'), stage);
      const maxPages = params.dryRun ? 1 : 10;

      for (let i = 0; i < maxPages && url && releases.length < pageSize; i++) {
        const res = await fetchWithRetry(
          url,
          {
            headers: { 'User-Agent': 'Mozilla/5.0 Evercam Source Hub research@evercam.io', Accept: 'application/json' },
          },
          { timeoutMs: 20_000 }
        );
        if (!res.ok) {
          throw new Error(`${cfg.slug} OCDS request failed: HTTP ${res.status} ${res.statusText}${await detail(res)}`);
        }
        let pkg: OcdsPackage;
        try {
          pkg = (await res.json()) as OcdsPackage;
        } catch {
          throw new AdapterShapeError(`${cfg.slug} OCDS response was not valid JSON.`);
        }
        if (!Array.isArray(pkg.releases)) {
          throw new AdapterShapeError(`${cfg.slug} OCDS response had no releases[].`);
        }
        releases.push(...pkg.releases);
        if (params.dryRun) break;
        url = pkg.links?.next;
      }

      // Client-side keyword + region filtering (OCDS windows are date-only server-side).
      let filtered = releases;
      // Default to construction/engineering only — these are general-procurement
      // publishers, so scope them to the tool's domain unless explicitly disabled.
      if (params.constructionOnly ?? true) {
        filtered = filtered.filter(isConstructionRelease);
      }
      if (params.keyword?.trim()) {
        const kw = params.keyword.trim().toLowerCase();
        filtered = filtered.filter((r) => {
          const hay = [r.tender?.title, r.tender?.description, r.contracts?.[0]?.title, r.contracts?.[0]?.description]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return hay.includes(kw);
        });
      }
      if (params.minValue) {
        filtered = filtered.filter((r) => {
          const v = firstValue(r.awards?.[0]?.value, r.contracts?.[0]?.value, r.tender?.value);
          return v != null && v.amount! >= params.minValue!;
        });
      }
      if (params.regions?.length) {
        const wanted = params.regions.map((x) => x.toLowerCase());
        filtered = filtered.filter((r) => {
          const buyer = partyByRole(r.parties, 'procuringEntity') ?? partyByRole(r.parties, 'buyer');
          const hay = [buyer?.address?.region, buyer?.address?.locality, buyer?.address?.countryName]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return wanted.some((w) => hay.includes(w));
        });
      }

      return filtered.slice(0, pageSize) as unknown as RawProjectRecord[];
    },

    normalize(raw: RawProjectRecord): CanonicalProjectInsert {
      const r = raw as unknown as OcdsRelease;
      const extId = String(r.ocid ?? r.id ?? '');
      const contract = r.contracts?.[0];
      const award = r.awards?.[0];

      const title = r.tender?.title || contract?.title || award?.title || contract?.description || 'Procurement notice';
      const description = r.tender?.description || contract?.description || award?.description || null;
      const value = firstValue(award?.value, contract?.value, r.tender?.value);

      // ICP critical_infra_owner => the "owner" is the public procuring entity.
      const owner = partyByRole(r.parties, 'procuringEntity') ?? partyByRole(r.parties, 'buyer');
      const companyName = owner?.name || r.buyer?.name || null;
      // Best contact across ALL parties (lead-actionability), not just the owner.
      const contact = bestContact(r.parties);
      const addr = owner?.address ?? null;
      const classification = (contract?.items?.[0] ?? r.tender?.items?.[0])?.classification;

      const announced = r.date || contract?.dateSigned || award?.date || null;
      const start = contract?.period?.startDate || null;
      const end = contract?.period?.endDate || null;

      const presentFields: Partial<Record<CriticalField, boolean>> = {
        project_name: isPresent(title),
        project_value: value != null,
        project_location: isPresent(addr?.region) || isPresent(addr?.locality) || isPresent(addr?.countryName),
        project_timeline: isPresent(announced) || isPresent(start),
        building_type: isPresent(classification?.description) || isPresent(classification?.id),
        company_name: isPresent(companyName),
        company_contact: isPresent(contact?.name),
        project_phase: isPresent(contract) || isPresent(award), // awarded vs tendering
        square_footage: false,
        funding_source: true, // public procurement
        company_website: false,
        company_phone: isPresent(contact?.telephone),
      };

      const completeness = computeCompleteness(presentFields);

      return {
        canonical_name: title.slice(0, 300),
        source_key: cfg.sourceKey,
        source_unique_id: extId,
        icp_code: cfg.icpCode,
        record_type: 'tender',
        bu: cfg.bu,
        project_type:
          classification?.description ||
          (classification?.id ? `${classification.scheme ?? ''} ${classification.id}`.trim() : null),
        building_type: classification?.description || null,
        description: description ? description.slice(0, 1000) : null,
        address_line1: null,
        city: addr?.locality ?? null,
        state_province: addr?.region ?? null,
        country: (addr?.countryName || cfg.countryCode).toString(),
        country_code: cfg.countryCode,
        announced_date: normalizeDate(announced),
        construction_start_date: normalizeDate(start),
        estimated_completion_date: normalizeDate(end),
        bid_date: null,
        project_url: null,
        current_phase: contract ? 'Contract Awarded' : award ? 'Awarded' : 'Tender',
        estimated_value: value?.amount ?? null,
        estimated_value_currency: value?.currency ?? null,
        company_name_raw: companyName,
        contact_name: contact?.name ?? null,
        contact_title: null,
        contact_email: contact?.email ?? null,
        contact_phone: contact?.telephone ?? null,
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

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export const findATenderAdapter = makeOcdsAdapter(OCDS_PUBLISHERS[0]);
export const austenderAdapter = makeOcdsAdapter(OCDS_PUBLISHERS[1]);
export const contractsFinderAdapter = makeOcdsAdapter(OCDS_PUBLISHERS[2]);
