import type { CriticalField, CompletenessTierCode } from '@/lib/supabase/types';

/**
 * Weight table for the 12 critical lead fields. Sums to 100 so a score can
 * be read directly as a percentage. Shared by the seed-data derivation logic
 * and by both live adapters (barbour-abi.ts, glenigan.ts) so completeness is
 * computed identically everywhere in the app.
 */
export const CRITICAL_FIELD_WEIGHTS: Record<CriticalField, number> = {
  project_name: 15,
  project_value: 12,
  project_location: 12,
  project_timeline: 10,
  building_type: 10,
  company_name: 10,
  company_contact: 8,
  project_phase: 8,
  square_footage: 5,
  funding_source: 5,
  company_website: 3,
  company_phone: 2,
};

export const ALL_CRITICAL_FIELDS = Object.keys(CRITICAL_FIELD_WEIGHTS) as CriticalField[];

/** data_completeness_tiers ranges, mirrored from supabase_setup.sql. */
export const COMPLETENESS_TIER_RANGES: { code: CompletenessTierCode; min: number; max: number }[] = [
  { code: 'A', min: 90, max: 100 },
  { code: 'B', min: 70, max: 89 },
  { code: 'C', min: 50, max: 69 },
  { code: 'D', min: 30, max: 49 },
  { code: 'E', min: 10, max: 29 },
];

export function scoreToTier(score: number): CompletenessTierCode {
  for (const range of COMPLETENESS_TIER_RANGES) {
    if (score >= range.min && score <= range.max) return range.code;
  }
  return score > 100 ? 'A' : 'E';
}

export interface CompletenessResult {
  fieldsPopulated: Partial<Record<CriticalField, boolean>>;
  fieldsMissing: CriticalField[];
  score: number;
  tier: CompletenessTierCode;
  populationPercentage: number;
}

/**
 * Given a map of which critical fields are non-null/non-empty on a
 * normalized record, compute the weighted completeness score, tier, and
 * missing-field list. Used by adapter `normalize()` functions.
 */
export function computeCompleteness(presentFields: Partial<Record<CriticalField, boolean>>): CompletenessResult {
  let score = 0;
  const fieldsMissing: CriticalField[] = [];

  for (const field of ALL_CRITICAL_FIELDS) {
    if (presentFields[field]) {
      score += CRITICAL_FIELD_WEIGHTS[field];
    } else {
      fieldsMissing.push(field);
    }
  }

  return {
    fieldsPopulated: presentFields,
    fieldsMissing,
    score,
    tier: scoreToTier(score),
    populationPercentage: score, // weights already sum to 100, so score === percentage
  };
}

export function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return !Number.isNaN(value);
  return true;
}
