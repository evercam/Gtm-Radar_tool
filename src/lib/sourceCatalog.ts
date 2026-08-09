/**
 * The sources this app can pull from — the live adapters plus the file/import
 * paths. Rendered on /sources and merged with real per-source counts from
 * canonical_projects. (Replaces the old static source_registry catalog.)
 */

export type SourceAuth = 'keyless' | 'keyed' | 'upload';

export interface CatalogSource {
  name: string;
  sourceKey: string; // canonical_projects.source_key
  slug?: string; // /search & /api slug (searchable adapters only)
  category: string;
  coverage: string; // BU / region
  auth: SourceAuth;
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
  },
  {
    name: 'Glenigan',
    sourceKey: 'glenigan',
    slug: 'glenigan',
    category: 'Construction DBs',
    coverage: 'UK',
    auth: 'keyed',
  },
  {
    name: 'ConstructConnect',
    sourceKey: 'construct_connect',
    slug: 'construct-connect',
    category: 'Construction DBs',
    coverage: 'USA',
    auth: 'keyed',
  },
  {
    name: 'Construction News (ICP hunt)',
    sourceKey: 'news_search',
    slug: 'news-search',
    category: 'News & Signals',
    coverage: 'USA / UK',
    auth: 'keyless',
  },
  // Public procurement
  { name: 'SAM.gov', sourceKey: 'sam_gov', slug: 'sam-gov', category: 'Procurement', coverage: 'USA', auth: 'keyed' },
  {
    name: 'Find a Tender',
    sourceKey: 'find_a_tender_uk',
    slug: 'find-a-tender',
    category: 'Procurement',
    coverage: 'UK',
    auth: 'keyless',
  },
  {
    name: 'Contracts Finder',
    sourceKey: 'contracts_finder_uk',
    slug: 'contracts-finder',
    category: 'Procurement',
    coverage: 'UK',
    auth: 'keyless',
  },
  {
    name: 'AusTender',
    sourceKey: 'austender',
    slug: 'austender',
    category: 'Procurement',
    coverage: 'APAC',
    auth: 'keyless',
  },
  { name: 'TED (EU)', sourceKey: 'ted', slug: 'ted', category: 'Procurement', coverage: 'Export', auth: 'keyless' },
  {
    name: 'USASpending.gov',
    sourceKey: 'usaspending_gov',
    slug: 'usaspending',
    category: 'Procurement',
    coverage: 'USA',
    auth: 'keyless',
  },
  {
    name: 'World Bank Projects',
    sourceKey: 'world_bank',
    slug: 'world-bank',
    category: 'Procurement',
    coverage: 'Export',
    auth: 'keyless',
  },
  // Permits & planning
  {
    name: 'NYC DOB Permits',
    sourceKey: 'nyc_dob_permits',
    slug: 'nyc-permits',
    category: 'Permits & planning',
    coverage: 'USA',
    auth: 'keyless',
  },
  {
    name: 'Chicago Building Permits',
    sourceKey: 'chicago_building_permits',
    slug: 'chicago-permits',
    category: 'Permits & planning',
    coverage: 'USA',
    auth: 'keyless',
  },
  {
    name: 'Planning IE',
    sourceKey: 'planning_ie',
    slug: 'planning-ie',
    category: 'Permits & planning',
    coverage: 'Ireland',
    auth: 'keyless',
  },
  // Regulatory filings
  {
    name: 'SEC EDGAR',
    sourceKey: 'sec_edgar',
    slug: 'sec-edgar',
    category: 'Regulatory filings',
    coverage: 'USA',
    auth: 'keyless',
  },
  // Industry news (RSS)
  {
    name: 'Data Center Dynamics',
    sourceKey: 'data_center_dynamics',
    slug: 'data-center-dynamics',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
  },
  {
    name: 'Data Center Knowledge',
    sourceKey: 'data_center_knowledge',
    slug: 'data-center-knowledge',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
  },
  {
    name: 'Semiconductor Digest',
    sourceKey: 'semiconductor_digest',
    slug: 'semiconductor-digest',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
  },
  {
    name: 'Electrive (battery/EV)',
    sourceKey: 'electrive',
    slug: 'electrive',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
  },
  {
    name: 'Power Technology',
    sourceKey: 'power_technology',
    slug: 'power-technology',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
  },
  {
    name: 'Nuclear Engineering Intl',
    sourceKey: 'nuclear_engineering_intl',
    slug: 'nuclear-engineering',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
  },
  {
    name: 'Mining.com',
    sourceKey: 'mining_com',
    slug: 'mining-com',
    category: 'Industry news',
    coverage: 'Export',
    auth: 'keyless',
  },
  {
    name: 'Construction Dive',
    sourceKey: 'construction_dive',
    slug: 'construction-dive',
    category: 'Industry news',
    coverage: 'USA',
    auth: 'keyless',
  },
  // Energy assets & ownership (files / import)
  {
    name: 'GEM Energy Trackers',
    sourceKey: 'gem_energy_tracker',
    slug: 'gem',
    category: 'Energy & ownership',
    coverage: 'Worldwide',
    auth: 'upload',
  },
  {
    name: 'GEM Ownership Tracker (GEOT)',
    sourceKey: 'geot',
    category: 'Energy & ownership',
    coverage: 'Worldwide',
    auth: 'upload',
  },
  {
    name: 'Key-account import (CSV)',
    sourceKey: 'key_account_import',
    category: 'Energy & ownership',
    coverage: 'Any',
    auth: 'upload',
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
