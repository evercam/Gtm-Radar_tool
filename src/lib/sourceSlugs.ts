/**
 * Single source of truth linking an adapter's URL slug (`barbour-abi`, used by
 * /api/search and /api/ingest) to its `source_credentials.source_key`
 * (`barbour_abi`, used everywhere in the schema).
 *
 * This used to be duplicated as an inline map in each route; keeping it here
 * means the search route, the ingest route and the credential-status endpoint
 * all agree on which sources need a key.
 */

export interface SourceSlugInfo {
  sourceKey: string;
  /** No credentials of any kind — open gov/EU data, RSS, or local files. */
  keyless?: boolean;
  /** Needs username + password on top of the API key (Barbour ABI's login). */
  needsUsername?: boolean;

  /**
   * The legacy environment variables this source's credentials used to be read
   * from. Nothing resolves through these any more — they exist solely so
   * `importEnvSourceCredentials` can find the values on an upgrading install
   * and encrypt them into the database once. Safe to delete an entry once no
   * deployment still sets that variable.
   */
  envApiKey?: string;
  envBaseUrl?: string;
  envUsername?: string;
  envApiSecret?: string;
}

export const SOURCE_SLUGS: Record<string, SourceSlugInfo> = {
  'barbour-abi': {
    sourceKey: 'barbour_abi',
    needsUsername: true,
    envApiKey: 'BARBOUR_ABI_API_KEY',
    envBaseUrl: 'BARBOUR_ABI_BASE_URL',
    envUsername: 'BARBOUR_ABI_USERNAME',
    envApiSecret: 'BARBOUR_ABI_PASSWORD',
  },
  glenigan: { sourceKey: 'glenigan', envApiKey: 'GLENIGAN_API_KEY', envBaseUrl: 'GLENIGAN_BASE_URL' },
  'construct-connect': {
    sourceKey: 'construct_connect',
    envApiKey: 'CONSTRUCT_CONNECT_API_KEY',
    envBaseUrl: 'CONSTRUCT_CONNECT_BASE_URL',
  },
  'sam-gov': { sourceKey: 'sam_gov', envApiKey: 'SAM_GOV_API_KEY', envBaseUrl: 'SAM_GOV_BASE_URL' },
  'sec-edgar': { sourceKey: 'sec_edgar', keyless: true },
  'find-a-tender': { sourceKey: 'find_a_tender_uk', keyless: true },
  austender: { sourceKey: 'austender', keyless: true },
  'contracts-finder': { sourceKey: 'contracts_finder_uk', keyless: true },
  ted: { sourceKey: 'ted', keyless: true },
  'world-bank': { sourceKey: 'world_bank', keyless: true },
  usaspending: { sourceKey: 'usaspending_gov', keyless: true },
  'planning-ie': { sourceKey: 'planning_ie', keyless: true },
  'nyc-permits': { sourceKey: 'nyc_dob_permits', keyless: true },
  'chicago-permits': { sourceKey: 'chicago_building_permits', keyless: true },
  'data-center-dynamics': { sourceKey: 'data_center_dynamics', keyless: true },
  'data-center-knowledge': { sourceKey: 'data_center_knowledge', keyless: true },
  'semiconductor-digest': { sourceKey: 'semiconductor_digest', keyless: true },
  electrive: { sourceKey: 'electrive', keyless: true },
  'power-technology': { sourceKey: 'power_technology', keyless: true },
  'nuclear-engineering': { sourceKey: 'nuclear_engineering_intl', keyless: true },
  'mining-com': { sourceKey: 'mining_com', keyless: true },
  'construction-dive': { sourceKey: 'construction_dive', keyless: true },
  gem: { sourceKey: 'gem_energy_tracker', keyless: true },
  'news-search': { sourceKey: 'news_search', keyless: true },
  'public-contracts-scotland': { sourceKey: 'public_contracts_scotland', keyless: true },
  'calgary-permits': { sourceKey: 'calgary_building_permits', keyless: true },
  'neso-tec': { sourceKey: 'neso_tec_register', keyless: true },
  'neso-embedded': { sourceKey: 'neso_embedded_register', keyless: true },
};

export function sourceKeyForSlug(slug: string): string | null {
  return SOURCE_SLUGS[slug]?.sourceKey ?? null;
}

export function isKeylessSlug(slug: string): boolean {
  return SOURCE_SLUGS[slug]?.keyless === true;
}

/** Slugs that need credentials — the ones /settings can usefully configure. */
export const KEYED_SLUGS = Object.keys(SOURCE_SLUGS).filter((s) => !SOURCE_SLUGS[s].keyless);
