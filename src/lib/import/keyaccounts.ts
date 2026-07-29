import { computeCompleteness, isPresent } from '@/lib/completeness';
import { accountKey } from '@/lib/keyaccount';
import { resolveGemBu } from '@/lib/gem/normalize';
import { sourceProvenance } from '@/lib/provenance';
import { csvToObjects } from '@/lib/import/csv';
import type { CanonicalProjectInsert } from '@/lib/adapters/types';
import type { CriticalField } from '@/lib/supabase/types';

/**
 * Import key-account rows from a spreadsheet (CSV). Each row becomes an
 * `account` record in canonical_projects, keyed by account_key, marked
 * 'source' in provenance — ready to be enriched (Claude + GLEIF + Apollo) and
 * kept live. Headers are matched flexibly, so most exports work as-is.
 */

export const KEY_ACCOUNT_SOURCE = 'key_account_import';

/** First non-empty value whose header matches (case-insensitive, contains) any candidate. */
function pick(row: Record<string, string>, candidates: string[]): string | null {
  const lower = Object.entries(row).map(([k, v]) => [k.toLowerCase().trim(), v] as const);
  for (const want of candidates) {
    for (const [k, v] of lower) {
      if ((k === want || k.includes(want)) && v && v.trim()) return v.trim();
    }
  }
  return null;
}

function numVal(s: string | null): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isNaN(n) ? null : n;
}

export function normalizeKeyAccountRow(row: Record<string, string>): CanonicalProjectInsert | null {
  const name = pick(row, [
    'account name',
    'company name',
    'account',
    'company',
    'organization',
    'organisation',
    'entity',
    'name',
  ]);
  if (!name) return null;

  const website = pick(row, ['website', 'url', 'web']);
  const domain = pick(row, ['domain']);
  const country = pick(row, ['country']);
  const state = pick(row, ['state', 'province', 'region']);
  const city = pick(row, ['city', 'town']);
  const value = numVal(pick(row, ['portfolio value', 'budget', 'value', 'deal', 'revenue', 'amount']));
  const contactName = pick(row, ['contact name', 'contact', 'poc', 'decision maker']);
  const contactEmail = pick(row, ['email', 'e-mail']);
  const contactPhone = pick(row, ['phone', 'tel', 'mobile', 'direct']);
  const contactTitle = pick(row, ['contact title', 'job title', 'title', 'position']);
  const sector = pick(row, ['sector', 'vertical', 'industry', 'type']);
  const role = pick(row, ['role', 'account role']);
  const notes = pick(row, ['notes', 'description', 'comment']);

  const key = accountKey(name) ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const bu = resolveGemBu(country, state);

  const presentFields: Partial<Record<CriticalField, boolean>> = {
    project_name: true,
    project_value: value != null,
    project_location: isPresent(country) || isPresent(city) || isPresent(state),
    project_timeline: false,
    building_type: isPresent(sector),
    company_name: true,
    company_contact: isPresent(contactName) || isPresent(contactEmail),
    project_phase: false,
    square_footage: false,
    funding_source: false,
    company_website: isPresent(website),
    company_phone: isPresent(contactPhone),
  };
  const completeness = computeCompleteness(presentFields);

  const rec: CanonicalProjectInsert = {
    canonical_name: name.slice(0, 300),
    source_key: KEY_ACCOUNT_SOURCE,
    source_unique_id: key,
    account_key: key,
    icp_code: null,
    record_type: 'account',
    bu,
    project_type: sector,
    building_type: sector,
    description: [role ? `Role: ${role}` : null, notes].filter(Boolean).join(' — ') || null,
    address_line1: null,
    city,
    state_province: state,
    country,
    country_code: null,
    announced_date: null,
    construction_start_date: null,
    estimated_completion_date: null,
    bid_date: null,
    project_url: website,
    current_phase: null,
    estimated_value: value,
    estimated_value_currency: value != null ? 'USD' : null,
    company_name_raw: name,
    company_website: website,
    company_domain: domain,
    contact_name: contactName,
    contact_title: contactTitle,
    contact_email: contactEmail,
    contact_phone: contactPhone,
    source_completeness_tier: completeness.tier,
    source_completeness_score: completeness.score,
    fields_populated: completeness.fieldsPopulated,
    fields_missing: completeness.fieldsMissing,
    population_percentage: completeness.populationPercentage,
    processing_status: 'normalized',
    raw_data: { ...row, __import: 'key_account' },
  };
  rec.field_provenance = sourceProvenance(rec as unknown as Record<string, unknown>);
  return rec;
}

export function normalizeKeyAccountCsv(text: string): {
  records: CanonicalProjectInsert[];
  parsed: number;
  failed: number;
} {
  const rows = csvToObjects(text);
  const records: CanonicalProjectInsert[] = [];
  let failed = 0;
  for (const row of rows) {
    const rec = normalizeKeyAccountRow(row);
    if (rec) records.push(rec);
    else failed += 1;
  }
  return { records, parsed: rows.length, failed };
}
