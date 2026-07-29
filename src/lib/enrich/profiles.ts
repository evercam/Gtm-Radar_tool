import type { EnrichInput } from './types';

/**
 * Per-source enrichment personalization. The "account" behind a record means
 * something different per source — an energy owner, a contractor, a public
 * buyer, a company named in a headline — so Claude gets different guidance and
 * Apollo targets different job titles for each.
 */

export interface EnrichmentProfile {
  key: string;
  /** Short human label shown in the UI, e.g. "Energy owner / operator". */
  accountRole: string;
  /** Source-specific instructions appended to the Claude prompt. */
  guidance: string;
  /** Apollo person_titles to target for this account type (most relevant first). */
  apolloTitles: string[];
}

const PROFILES: Record<string, EnrichmentProfile> = {
  energy_owner: {
    key: 'energy_owner',
    accountRole: 'Energy / industrial asset owner or operator',
    guidance:
      'This is an energy, extraction, or heavy-industry asset from Global Energy Monitor. The ACCOUNT is the OWNER or OPERATOR of the facility (a utility, IPP, oil & gas, mining, or industrial company). Target the people responsible for BUILDING and delivering new capacity, not corporate/IR.',
    apolloTitles: [
      'Head of Construction',
      'VP Engineering',
      'Project Director',
      'Capital Projects',
      'Head of Projects',
      'Development Director',
      'Construction Manager',
      'EPC',
    ],
  },
  contractor: {
    key: 'contractor',
    accountRole: 'Contractor (permittee / awardee)',
    guidance:
      "The ACCOUNT is the CONTRACTOR named on this permit or award (the firm doing the work), not the property owner or the public body. Target the contractor's field/construction leadership.",
    apolloTitles: [
      'Project Manager',
      'Project Executive',
      'Preconstruction',
      'VP Construction',
      'Operations Manager',
      'Estimator',
      'Superintendent',
    ],
  },
  public_buyer: {
    key: 'public_buyer',
    accountRole: 'Public buyer / procuring entity',
    guidance:
      'This is a public PROCUREMENT notice. The ACCOUNT is the procuring public body (council, agency, department). A buyer contact may already exist on the record — verify and complement it. Target capital-projects, estates, and facilities leads; if a winning contractor is named, they are a secondary account.',
    apolloTitles: [
      'Head of Estates',
      'Capital Projects',
      'Head of Property',
      'Procurement Director',
      'Facilities',
      'Programme Director',
      'Head of Construction',
    ],
  },
  news_operator: {
    key: 'news_operator',
    accountRole: 'Operator / developer named in the news',
    guidance:
      'This came from an industry NEWS headline, so the account is not yet resolved. FIRST identify the operator/developer/owner company named or clearly implied in the title/description (e.g. the hyperscaler, fab owner, gigafactory developer, energy operator). THEN target their new-build, critical-facilities, and site-delivery decision-makers.',
    apolloTitles: [
      'Head of Data Center',
      'Critical Facilities',
      'Data Center Construction',
      'VP Infrastructure',
      'Head of Construction',
      'Development Director',
      'Capital Projects',
    ],
  },
  public_company: {
    key: 'public_company',
    accountRole: 'Public company (filing)',
    guidance:
      'The ACCOUNT is the PUBLIC COMPANY in this regulatory filing. Focus on the capex/facility commitment disclosed. Target real-estate, capital-projects, and facilities decision-makers responsible for delivering the disclosed investment.',
    apolloTitles: [
      'Head of Real Estate',
      'Capital Projects',
      'Head of Facilities',
      'VP Operations',
      'Corporate Development',
      'Head of Construction',
    ],
  },
  developer_owner: {
    key: 'developer_owner',
    accountRole: 'Developer / owner / main contractor',
    guidance:
      'The ACCOUNT is the OWNER, DEVELOPER, or MAIN CONTRACTOR behind this construction project. Target the people who commission or deliver the build.',
    apolloTitles: [
      'Project Director',
      'Development Director',
      'Head of Construction',
      'Preconstruction',
      'Head of Projects',
      'Managing Director',
    ],
  },
};

/** source_key -> profile category. */
const SOURCE_PROFILE: Record<string, keyof typeof PROFILES> = {
  gem_energy_tracker: 'energy_owner',
  nyc_dob_permits: 'contractor',
  chicago_building_permits: 'contractor',
  usaspending_gov: 'contractor',
  sam_gov: 'public_buyer',
  find_a_tender_uk: 'public_buyer',
  austender: 'public_buyer',
  contracts_finder_uk: 'public_buyer',
  ted: 'public_buyer',
  world_bank: 'public_buyer',
  sec_edgar: 'public_company',
  data_center_dynamics: 'news_operator',
  data_center_knowledge: 'news_operator',
  semiconductor_digest: 'news_operator',
  electrive: 'news_operator',
  power_technology: 'news_operator',
  nuclear_engineering_intl: 'news_operator',
  mining_com: 'news_operator',
  construction_dive: 'news_operator',
  barbour_abi: 'developer_owner',
  glenigan: 'developer_owner',
  constructconnect: 'developer_owner',
  planning_ie: 'developer_owner',
};

/** Fallback by record_type when the source_key isn't mapped. */
function fallbackByRecordType(recordType?: string | null): keyof typeof PROFILES {
  switch (recordType) {
    case 'news':
      return 'news_operator';
    case 'tender':
      return 'public_buyer';
    case 'permit':
      return 'contractor';
    case 'filing':
      return 'public_company';
    default:
      return 'developer_owner';
  }
}

/** Resolve the enrichment profile for a record — by source first, else record type. */
export function getEnrichmentProfile(input: EnrichInput): EnrichmentProfile {
  const bySource = input.source_key ? SOURCE_PROFILE[input.source_key] : undefined;
  return PROFILES[bySource ?? fallbackByRecordType(input.record_type)];
}
