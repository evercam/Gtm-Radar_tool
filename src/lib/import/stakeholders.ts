import { computeCompleteness, isPresent } from '@/lib/completeness';
import { accountKey } from '@/lib/keyaccount';
import { resolveGemBu } from '@/lib/gem/normalize';
import { csvToObjects } from '@/lib/import/csv';
import type { CanonicalProjectInsert } from '@/lib/adapters/types';
import type { CriticalField } from '@/lib/supabase/types';

/**
 * Import the Project Intelligence stakeholder export.
 *
 * The file is one row per STAKEHOLDER, not per project — roughly six named
 * people against each of thirty projects. Each row becomes its own record,
 * because a lead here is a person you can call, and collapsing six of them
 * into one project row would throw away five of the contacts that make the
 * export worth having. The shared project fields repeat across the sibling
 * rows, which is exactly how the tender and permit adapters already behave;
 * `accounts_view` regroups them by company.
 *
 * Every row already carries a hand-researched contact, so these land at a far
 * higher completeness tier than anything an adapter produces — they are
 * enrichment targets only for the ~20% with no email.
 */

export const STAKEHOLDER_SOURCE = 'project_intelligence';

/** ICP Type in the file → the platform's ICP vocabulary. */
const ICP_MAP: Record<string, string> = {
  owner: 'critical_infra_owner',
  gc: 'tier1_gc',
};

/**
 * Project Status → the platform's phase vocabulary. Kept verbatim where the
 * file's wording is already the clearer one.
 */
const PHASE_MAP: Record<string, string> = {
  'under construction': 'Under Construction',
  commissioning: 'Commissioning',
  'pre-construction': 'Pre-Construction',
  'on hold': 'On Hold',
  permitting: 'Permitting',
};

/**
 * US states by both spellings the export uses — "Durham, NC" and "Siler City,
 * North Carolina" appear for the same state, sometimes for the same town, so
 * every value is normalised to the full name. Without this they would sort,
 * filter and group as two different places.
 */
const US_STATES: Record<string, string> = {};
for (const [code, name] of [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
] as const) {
  US_STATES[code.toLowerCase()] = name;
  US_STATES[name.toLowerCase()] = name;
}

const CA_PROVINCES: Record<string, string> = {};
for (const [code, name] of [
  ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'],
  ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'],
  ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'],
  ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
] as const) {
  CA_PROVINCES[code.toLowerCase()] = name;
  CA_PROVINCES[name.toLowerCase()] = name;
}

function clean(v: string | undefined | null): string | null {
  const t = (v ?? '').trim();
  return t.length ? t : null;
}

function num(v: string | undefined | null): number | null {
  const t = clean(v);
  if (!t) return null;
  const n = Number(t.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Split "Clay, New York" or "Amarillo, TX" into city, state and country.
 *
 * A location whose last segment names no state or province we recognise is
 * left whole in `city` with a null country: a wrong country silently routes
 * the record to the wrong business unit, which is worse than an unrouted one.
 */
function splitLocation(location: string | null): { city: string | null; state: string | null; country: string | null } {
  if (!location) return { city: null, state: null, country: null };
  const parts = location
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { city: null, state: null, country: null };

  const tail = parts[parts.length - 1].toLowerCase();
  const us = US_STATES[tail];
  const ca = CA_PROVINCES[tail];
  if (!us && !ca) return { city: location, state: null, country: null };

  const city = parts.length > 1 ? parts.slice(0, -1).join(', ') : null;
  return us ? { city, state: us, country: 'United States' } : { city, state: ca!, country: 'Canada' };
}

/** ISO date from the file's mixed date/timestamp formats. */
function isoDate(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function normalizeStakeholderRow(row: Record<string, string>): CanonicalProjectInsert | null {
  const stakeholderId = clean(row['Stakeholder ID']);
  const contactName = clean(row['Name']);
  const projectName = clean(row['Project Name']);
  const company = clean(row['Company']);

  // Without an id there is nothing stable to dedupe on, and without a project
  // or a person the row is not a lead.
  if (!stakeholderId || !projectName || !contactName) return null;

  const projectLocation = clean(row['Project Location']);
  const loc = splitLocation(projectLocation);
  const contactLocation = clean(row['Contact Location']);

  const category = (clean(row['Project Category']) ?? '').toLowerCase();
  const status = (clean(row['Project Status']) ?? '').toLowerCase();
  const icpType = (clean(row['ICP Type']) ?? '').toLowerCase();

  const email = clean(row['Email']);
  const phone = clean(row['Phone']);
  const title = clean(row['Title']);
  const linkedin = clean(row['LinkedIn URL']);

  const bu = resolveGemBu(loc.country, loc.state);

  const presentFields: Partial<Record<CriticalField, boolean>> = {
    project_name: isPresent(projectName),
    project_location: isPresent(projectLocation),
    project_phase: isPresent(status),
    building_type: isPresent(category),
    company_name: isPresent(company),
    company_contact: isPresent(contactName),
    company_phone: isPresent(phone),
    company_website: false,
    project_timeline: false,
    // The export is a research product, not a bid feed: it names people and
    // projects, never budgets or areas.
    project_value: false,
    square_footage: false,
    funding_source: false,
  };
  const completeness = computeCompleteness(presentFields);

  return {
    canonical_name: projectName.slice(0, 300),
    source_key: STAKEHOLDER_SOURCE,
    source_unique_id: stakeholderId,
    icp_code: ICP_MAP[icpType] ?? 'critical_infra_owner',
    record_type: 'project',
    bu,
    // `vertical` is a generated column derived from these two, so the source
    // category is stored verbatim rather than pre-mapped — the classification
    // stays in one place, in SQL.
    project_type: clean(row['Project Category']),
    building_type: clean(row['Project Category']),
    description: [
      contactName,
      title,
      company ? `at ${company}` : null,
      `— ${clean(row['Persona']) ?? 'stakeholder'} on ${projectName}`,
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 1000),
    address_line1: null,
    city: loc.city,
    state_province: loc.state,
    country: loc.country,
    country_code: loc.country === 'United States' ? 'US' : loc.country === 'Canada' ? 'CA' : null,
    announced_date: null,
    construction_start_date: null,
    estimated_completion_date: null,
    bid_date: null,
    project_url: null,
    current_phase: PHASE_MAP[status] ?? clean(row['Project Status']),
    estimated_value: null,
    estimated_value_currency: null,
    company_name_raw: company,
    account_key: accountKey(company),
    contact_name: contactName,
    contact_title: title,
    contact_email: email,
    contact_phone: phone,
    source_completeness_tier: completeness.tier,
    source_completeness_score: completeness.score,
    fields_populated: completeness.fieldsPopulated,
    fields_missing: completeness.fieldsMissing,
    population_percentage: completeness.populationPercentage,
    processing_status: 'normalized',
    // Everything the columns above cannot hold — the scoring, the CRM state,
    // the assignment and the research notes — is kept verbatim so nothing in
    // the export is lost on the way in.
    raw_data: {
      stakeholder_id: stakeholderId,
      persona: clean(row['Persona']),
      company_role: clean(row['Company Role']),
      tier: num(row['Tier']),
      icp_type: clean(row['ICP Type']),
      distance_type: clean(row['Distance Type']),
      distance_score: num(row['Distance Score']),
      total_score: num(row['Total Score']),
      linkedin_url: linkedin,
      contact_location: contactLocation,
      project_id: clean(row['Project ID']),
      project_name: projectName,
      project_category: clean(row['Project Category']),
      project_location: projectLocation,
      project_status: clean(row['Project Status']),
      crm_status: clean(row['CRM Status']),
      crm_owner: clean(row['CRM Owner']),
      last_crm_activity: clean(row['Last CRM Activity']),
      // The export ships this header misspelled; keep the value, fix the key.
      assigned_bdr: clean(row['Assinged BDR']) ?? clean(row['Assigned BDR']),
      ae_owner: clean(row['AE Owner']),
      assignment_source: clean(row['Assignment Source']),
      battle_card: clean(row['Battle Card']),
      research_activity: clean(row['Research Activity']),
      research_confidence: clean(row['Research Confidence']),
      date_enriched: isoDate(clean(row['Date Enriched'])),
    } as unknown as CanonicalProjectInsert['raw_data'],
  };
}

export function normalizeStakeholderCsv(text: string): {
  records: CanonicalProjectInsert[];
  parsed: number;
  failed: number;
} {
  const rows = csvToObjects(text);
  const records: CanonicalProjectInsert[] = [];
  let failed = 0;

  // The export can list the same stakeholder against a project twice; the
  // upsert would collapse them anyway, but deduping here keeps the reported
  // counts honest.
  const seen = new Set<string>();
  for (const row of rows) {
    const rec = normalizeStakeholderRow(row);
    if (!rec) {
      failed += 1;
      continue;
    }
    if (seen.has(rec.source_unique_id)) continue;
    seen.add(rec.source_unique_id);
    records.push(rec);
  }

  return { records, parsed: rows.length, failed };
}
