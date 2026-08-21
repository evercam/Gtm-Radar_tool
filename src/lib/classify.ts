import 'server-only';
import { createHash } from 'node:crypto';

/**
 * TypeScript mirror of the SQL classification in
 * supabase/migrations/20260725133258_classification_and_ids.sql.
 *
 * The DB computes these as generated columns for PERSISTED rows. This module
 * computes the identical values for records that never touch the DB — the
 * stateless /api/search results — so search shows the same ref_code /
 * contact_status / vertical / org_path a row would get once ingested.
 *
 * Keep the two in lockstep: any change to the rules must be made in BOTH files.
 */

export type ContactStatus = 'has_contact' | 'needs_enrichment';

export interface Classification {
  vertical: string;
  contact_status: ContactStatus;
  ref_code: string;
  org_path: string;
}

export interface ClassifiableRecord {
  bu?: string | null;
  building_type?: string | null;
  project_type?: string | null;
  record_type?: string | null;
  country_code?: string | null;
  state_province?: string | null;
  source_key?: string | null;
  source_unique_id?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
}

const VERTICAL_CODE: Record<string, string> = {
  data_center: 'DCTR',
  semiconductor: 'SEMI',
  battery: 'BATT',
  solar: 'SOLR',
  wind: 'WIND',
  nuclear: 'NUCL',
  hydro: 'HYDR',
  bioenergy: 'BIOE',
  power: 'POWR',
  pharma: 'PHRM',
  pipeline: 'PIPE',
  coal: 'COAL',
  oil_gas: 'OLGS',
  mining: 'MINE',
  steel: 'STEL',
  cement: 'CMNT',
  chemicals: 'CHEM',
  procurement: 'PROC',
  construction: 'CNST',
  market_intel: 'MINT',
  capital_projects: 'CAPX',
};

const BU_CODE: Record<string, string> = { usa: 'USA', uk: 'UK', ireland: 'IE', apac: 'APAC', export: 'EXP' };

/** Sector, inferred from building/project type, else from record_type. */
export function leadVertical(
  buildingType?: string | null,
  projectType?: string | null,
  recordType?: string | null
): string {
  const s = (buildingType || projectType || '').toLowerCase();
  const has = (needle: string) => s.includes(needle);
  if (has('data cent')) return 'data_center';
  if (has('semiconduct') || has('fab')) return 'semiconductor';
  if (has('batter') || has('gigafact')) return 'battery';
  if (has('solar')) return 'solar';
  if (has('wind')) return 'wind';
  if (has('nuclear')) return 'nuclear';
  if (has('hydro')) return 'hydro';
  // Before the generic power test below, so "Global Bioenergy Power Tracker"
  // reads as bioenergy rather than as unclassified generation.
  if (has('bioenerg') || has('biomass') || has('biogas')) return 'bioenergy';
  if (has('pipeline')) return 'pipeline';
  if (has('coal')) return 'coal';
  if (has('oil') || has('gas') || has('lng')) return 'oil_gas';
  if (has('mine') || has('mining')) return 'mining';
  if (has('steel')) return 'steel';
  if (has('cement')) return 'cement';
  if (has('chemical')) return 'chemicals';
  if (has('pharmaceutic') || has('biotech') || has('life science')) return 'pharma';
  if (has('power generation') || has('power plant') || has('geotherm')) return 'power';
  if (has('stadium') || has('arena')) return 'construction';
  if (recordType === 'tender') return 'procurement';
  if (recordType === 'permit') return 'construction';
  if (recordType === 'news') return 'market_intel';
  if (recordType === 'filing') return 'capital_projects';
  return 'other';
}

export function verticalCode(vertical: string): string {
  return VERTICAL_CODE[vertical] ?? 'OTHR';
}

export function buCode(bu?: string | null): string {
  return BU_CODE[bu ?? ''] ?? (bu ? bu.toUpperCase() : 'XX');
}

export function contactStatus(rec: ClassifiableRecord): ContactStatus {
  return rec.contact_email || rec.contact_phone || rec.contact_name ? 'has_contact' : 'needs_enrichment';
}

function hash8(sourceKey?: string | null, sourceUniqueId?: string | null): string {
  return createHash('md5')
    .update(`${sourceKey ?? ''}|${sourceUniqueId ?? ''}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
}

/** Stable business id: BU-VERTICAL-COUNTRY-HASH (e.g. USA-DCTR-US-A1B2C3D4). */
export function refCode(rec: ClassifiableRecord): string {
  const v = leadVertical(rec.building_type, rec.project_type, rec.record_type);
  const cc = (rec.country_code || 'XX').toUpperCase();
  return `${buCode(rec.bu)}-${verticalCode(v)}-${cc}-${hash8(rec.source_key, rec.source_unique_id)}`;
}

/** Grouping path incl. mutable dims: bu/vertical/country/state/contact_status. */
export function orgPath(rec: ClassifiableRecord): string {
  const v = leadVertical(rec.building_type, rec.project_type, rec.record_type);
  const cc = (rec.country_code || 'XX').toUpperCase();
  const state = rec.state_province && rec.state_province.trim() ? rec.state_province : 'unknown';
  return `${rec.bu ?? 'export'}/${v}/${cc}/${state}/${contactStatus(rec)}`;
}

export function classify(rec: ClassifiableRecord): Classification {
  return {
    vertical: leadVertical(rec.building_type, rec.project_type, rec.record_type),
    contact_status: contactStatus(rec),
    ref_code: refCode(rec),
    org_path: orgPath(rec),
  };
}
