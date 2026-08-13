/**
 * The sources this app can pull from — the live adapters plus the file/import
 * paths. Rendered on /sources and merged with real per-source counts from
 * canonical_projects. (Replaces the old static source_registry catalog.)
 */

export type SourceAuth = 'keyless' | 'keyed' | 'upload';

/**
 * HOW EARLY THIS SOURCE SPEAKS, relative to ground-breaking.
 *
 * Evercam installs at mobilisation, so the only question that ranks a lead is how
 * far in front of the work we are. `arrivalFor` answers it from a record's dates —
 * but 63.3% of records carry neither a construction start nor a bid date, and they
 * all come back `unconfirmed`. Measured 2026-08-13, that bucket cannot tell these
 * two apart:
 *
 *   an ISSUED Chicago building permit   work starts in weeks; the latest useful signal
 *   a MISO Phase 1 queue entry          the project does not physically exist yet
 *
 * Both `unconfirmed`, both warm, both equally eligible for enrichment spend — and
 * ~50,000 permits outnumber the 3,728 queue entries by more than 13 to 1. No date
 * on those records can separate them, because the records HAVE no dates.
 *
 * What can separate them is the source. A building permit is intrinsically
 * late-stage information and an interconnection queue is intrinsically early-stage,
 * whatever any individual row says. That is a property of the publisher, it is
 * knowable for all 29 live adapters, and this is where it gets written down.
 *
 * Deliberately an ORDINAL SCALE, not a month count. "Roughly three years before
 * ground-breaking" is a true statement about interconnection queues and a false
 * precision if stored as `36`; nothing here should be subtracted from a date. It
 * exists to ORDER the undated majority, and ordering is all it is used for.
 */
export type SignalLead =
  /** The project does not physically exist yet — grid queues, scoping registers. */
  | 'pre_project'
  /** Permission is being sought. Years out, and some of it never gets built. */
  | 'planning'
  /** The work is being tendered or awarded. Months out, and funded. */
  | 'procurement'
  /** Permission granted, work imminent. The latest point still worth a call. */
  | 'permitted'
  /** Press and filings. Genuinely early sometimes, stale others — unrankable. */
  | 'announced'
  /** Built, operating or historical. Ownership context, not a pipeline. */
  | 'existing';

/**
 * Sort position and wording for each lead. Lower sorts first — earliest wins.
 *
 * `announced` sits BELOW procurement despite often being the first public word on
 * a project, because the spread is the problem: a data-centre press release can
 * precede ground-breaking by two years or report a topping-out. An unrankable
 * source cannot be ranked highly on the strength of its best case.
 */
export const SIGNAL_LEAD: Record<SignalLead, { order: number; label: string }> = {
  pre_project: { order: 0, label: 'years before ground-breaking — the project does not exist yet' },
  planning: { order: 1, label: 'one to three years out — seeking permission' },
  procurement: { order: 2, label: 'months out — being tendered or awarded' },
  announced: { order: 3, label: 'timing varies — press and filings, early or stale' },
  permitted: { order: 4, label: 'weeks out — permission granted, work imminent' },
  existing: { order: 5, label: 'already built or operating — context, not pipeline' },
};

export interface CatalogSource {
  name: string;
  sourceKey: string; // canonical_projects.source_key
  slug?: string; // /search & /api slug (searchable adapters only)
  category: string;
  coverage: string; // BU / region
  auth: SourceAuth;
  /** How early this source speaks. See `SignalLead`. */
  signalLead: SignalLead;
}

/**
 * How early a source speaks, by `source_key`.
 *
 * Falls back to `announced` for a source_key with no catalog entry, which is the
 * only honest default: an unknown publisher cannot be claimed to be early, and
 * `announced` is the bucket that already means "timing varies". Returning
 * `pre_project` would promote every unrecognised row to the top of the book.
 */
export function signalLeadFor(sourceKey: string | null | undefined): SignalLead {
  if (!sourceKey) return 'announced';
  return SOURCE_CATALOG.find((s) => s.sourceKey === sourceKey)?.signalLead ?? 'announced';
}

export const SOURCE_CATALOG: CatalogSource[] = [
  // Construction project databases
  {
    name: 'Barbour ABI',
    sourceKey: 'barbour_abi',
    slug: 'barbour-abi',
    category: 'Construction DBs',
    coverage: 'UK',
    auth: 'keyed',
    signalLead: 'planning',
  },
  {
    name: 'Glenigan',
    sourceKey: 'glenigan',
    slug: 'glenigan',
    category: 'Construction DBs',
    coverage: 'UK',
    auth: 'keyed',
    signalLead: 'planning',
  },
  {
    name: 'ConstructConnect',
    sourceKey: 'construct_connect',
    slug: 'construct-connect',
    category: 'Construction DBs',
    coverage: 'USA',
    auth: 'keyed',
    signalLead: 'procurement',
  },
  {
    name: 'Construction News (ICP hunt)',
    sourceKey: 'news_search',
    slug: 'news-search',
    category: 'News & Signals',
    coverage: 'USA / UK',
    auth: 'keyless',
    signalLead: 'announced',
  },
  // Public procurement
  { name: 'SAM.gov', sourceKey: 'sam_gov', slug: 'sam-gov', category: 'Procurement', coverage: 'USA', auth: 'keyed', signalLead: 'procurement' },
  {
    name: 'Find a Tender',
    sourceKey: 'find_a_tender_uk',
    slug: 'find-a-tender',
    category: 'Procurement',
    coverage: 'UK',
    auth: 'keyless',
    signalLead: 'procurement',
  },
  {
    name: 'Contracts Finder',
    sourceKey: 'contracts_finder_uk',
    slug: 'contracts-finder',
    category: 'Procurement',
    coverage: 'UK',
    auth: 'keyless',
    signalLead: 'procurement',
  },
  {
    name: 'Calgary Building Permits',
    sourceKey: 'calgary_building_permits',
    slug: 'calgary-permits',
    category: 'Permits & planning',
    coverage: 'Export',
    auth: 'keyless',
    signalLead: 'permitted',
  },
  {
    name: 'NESO TEC Register',
    sourceKey: 'neso_tec_register',
    slug: 'neso-tec',
    category: 'Asset & energy trackers',
    coverage: 'UK',
    auth: 'keyless',
    signalLead: 'pre_project',
  },
  {
    name: 'NESO Embedded Register',
    sourceKey: 'neso_embedded_register',
    slug: 'neso-embedded',
    category: 'Asset & energy trackers',
    coverage: 'UK',
    auth: 'keyless',
    signalLead: 'pre_project',
  },
  {
    name: 'MISO Interconnection Queue',
    sourceKey: 'miso_interconnection_queue',
    slug: 'miso-queue',
    category: 'Asset & energy trackers',
    coverage: 'USA',
    auth: 'keyless',
    signalLead: 'pre_project',
  },
  {
    name: 'Public Contracts Scotland',
    sourceKey: 'public_contracts_scotland',
    slug: 'public-contracts-scotland',
    category: 'Procurement',
    coverage: 'UK',
    auth: 'keyless',
    signalLead: 'procurement',
  },
  {
    name: 'AusTender',
    sourceKey: 'austender',
    slug: 'austender',
    category: 'Procurement',
    coverage: 'APAC',
    auth: 'keyless',
    signalLead: 'procurement',
  },
  { name: 'TED (EU)', sourceKey: 'ted', slug: 'ted', category: 'Procurement', coverage: 'Export', auth: 'keyless', signalLead: 'procurement' },
  {
    name: 'USASpending.gov',
    sourceKey: 'usaspending_gov',
    slug: 'usaspending',
    category: 'Procurement',
    coverage: 'USA',
    auth: 'keyless',
    signalLead: 'procurement',
  },
  {
    name: 'World Bank Projects',
    sourceKey: 'world_bank',
    slug: 'world-bank',
    category: 'Procurement',
    coverage: 'Export',
    auth: 'keyless',
    signalLead: 'planning',
  },
  // Permits & planning
  {
    name: 'NYC DOB Permits',
    sourceKey: 'nyc_dob_permits',
    slug: 'nyc-permits',
    category: 'Permits & planning',
    coverage: 'USA',
    auth: 'keyless',
    signalLead: 'permitted',
  },
  {
    name: 'Chicago Building Permits',
    sourceKey: 'chicago_building_permits',
    slug: 'chicago-permits',
    category: 'Permits & planning',
    coverage: 'USA',
    auth: 'keyless',
    signalLead: 'permitted',
  },
  {
    name: 'Planning IE',
    sourceKey: 'planning_ie',
    slug: 'planning-ie',
    category: 'Permits & planning',
    coverage: 'Ireland',
    auth: 'keyless',
    signalLead: 'planning',
  },
  // Regulatory filings
  {
    name: 'SEC EDGAR',
    sourceKey: 'sec_edgar',
    slug: 'sec-edgar',
    category: 'Regulatory filings',
    coverage: 'USA',
    auth: 'keyless',
    signalLead: 'announced',
  },
  // Industry news (RSS)
  {
    name: 'Data Center Dynamics',
    sourceKey: 'data_center_dynamics',
    slug: 'data-center-dynamics',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
    signalLead: 'announced',
  },
  {
    name: 'Data Center Knowledge',
    sourceKey: 'data_center_knowledge',
    slug: 'data-center-knowledge',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
    signalLead: 'announced',
  },
  {
    name: 'Semiconductor Digest',
    sourceKey: 'semiconductor_digest',
    slug: 'semiconductor-digest',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
    signalLead: 'announced',
  },
  {
    name: 'Electrive (battery/EV)',
    sourceKey: 'electrive',
    slug: 'electrive',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
    signalLead: 'announced',
  },
  {
    name: 'Power Technology',
    sourceKey: 'power_technology',
    slug: 'power-technology',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
    signalLead: 'announced',
  },
  {
    name: 'Nuclear Engineering Intl',
    sourceKey: 'nuclear_engineering_intl',
    slug: 'nuclear-engineering',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
    signalLead: 'announced',
  },
  {
    name: 'Mining.com',
    sourceKey: 'mining_com',
    slug: 'mining-com',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
    signalLead: 'announced',
  },
  {
    name: 'Construction Dive',
    sourceKey: 'construction_dive',
    slug: 'construction-dive',
    category: 'Industry news',
    coverage: 'USA',
    auth: 'keyless',
    signalLead: 'announced',
  },
  // Energy assets & ownership (files / import)
  {
    /*
      A one-off research import of data-centre projects, loaded 2026-07-27.

      Declared here because 179 records already carry this source_key, and a
      source_key with no catalog entry is invisible: /sources cannot show it, its
      count appears in no total, and nobody can tell whether the records are
      current or abandoned. They are good records — every one names a contractor,
      142 carry an email, and all are under construction — which made the silence
      worse rather than better.

      No slug and no adapter, deliberately: there is nothing to re-run. It is a
      historical import, and saying so is the point.
    */
    name: 'Project Intelligence (imported)',
    sourceKey: 'project_intelligence',
    category: 'Construction DBs',
    coverage: 'USA / Export',
    auth: 'upload',
    signalLead: 'permitted',
  },
  {
    name: 'GEM Energy Trackers',
    sourceKey: 'gem_energy_tracker',
    slug: 'gem',
    category: 'Energy & ownership',
    coverage: 'Worldwide',
    auth: 'upload',
    signalLead: 'existing',
  },
  {
    name: 'GEM Ownership Tracker (GEOT)',
    sourceKey: 'geot',
    category: 'Energy & ownership',
    coverage: 'Worldwide',
    auth: 'upload',
    signalLead: 'existing',
  },
  {
    name: 'Key-account import (CSV)',
    sourceKey: 'key_account_import',
    category: 'Energy & ownership',
    coverage: 'Any',
    auth: 'upload',
    signalLead: 'existing',
  },
];

export const CATALOG_CATEGORIES = [
  'Construction DBs',
  'Procurement',
  'Permits & planning',
  'Regulatory filings',
  'Industry news',
  'Energy & ownership',
];
