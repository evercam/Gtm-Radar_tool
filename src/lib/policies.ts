/**
 * Policy loader. Every tunable rule in the app — routing, scoring, enrichment
 * — lives in a policy table so it can be changed from /settings without a
 * deploy. This module is the one place that reads them, and it never throws: a
 * missing table, a missing row, or an unparseable payload all fall back to the
 * built-in defaults so the app works before any of it is set up.
 */

import { getServiceSupabase } from '@/lib/supabase/server';
import { DEFAULT_PRIORITY_CONFIG, mergePriorityConfig, type PriorityConfig } from '@/lib/priority';
import { DEFAULT_ENRICHMENT_POLICY, mergeEnrichmentPolicy, type EnrichmentPolicy } from '@/lib/enrich/policy';
import { BUSINESS_UNITS } from '@/lib/semantics';

/**
 * Configuration reads go through the service role, not the caller's session.
 *
 * These tables are not scoped to a person — their policies say "any signed-in
 * user may read", and the pages that render them are permission-gated already.
 * Routing them through the request client made them depend on a PostgREST
 * token this app can no longer mint, so they silently returned nothing: a
 * roster entry would save correctly and then not appear.
 *
 * `canonical_projects` is deliberately NOT in this group. That data IS scoped
 * per user, and it waits for the direct-Postgres path in lib/db/pool.ts rather
 * than being widened to the service role.
 */
const configReader = () => getServiceSupabase();

export interface LoadedPolicy<T> {
  /** The effective policy — saved values merged onto the defaults. */
  config: T;
  /** True when nothing is saved and the built-in defaults are in force. */
  isDefault: boolean;
}

async function loadPolicy<T>(
  table: string,
  merge: (input: unknown) => T,
  fallback: T,
  id = 'default'
): Promise<LoadedPolicy<T>> {
  try {
    const supabase = configReader();
    const { data, error } = await supabase.from(table).select('config').eq('id', id).maybeSingle();
    if (error || !data?.config || Object.keys(data.config as object).length === 0) {
      return { config: fallback, isDefault: true };
    }
    return { config: merge(data.config), isDefault: false };
  } catch {
    return { config: fallback, isDefault: true };
  }
}

/**
 * Global scoring config — the fallback every business unit inherits from.
 * Use `getScoringPolicies()` when scoring records that span BUs.
 */
export function getScoringPolicy(): Promise<LoadedPolicy<PriorityConfig>> {
  return loadPolicy('scoring_policy', mergePriorityConfig, DEFAULT_PRIORITY_CONFIG);
}

/** Admin-parameterized enrichment policy (engines, batch caps, eligibility). */
export function getEnrichmentPolicy(): Promise<LoadedPolicy<EnrichmentPolicy>> {
  return loadPolicy('enrichment_policy', mergeEnrichmentPolicy, DEFAULT_ENRICHMENT_POLICY);
}

/** A scoring config per business unit, plus the global default they inherit. */
export interface ScoringPolicySet {
  /** Keyed by BU, plus `default`. Always contains `default`. */
  byBu: Record<string, PriorityConfig>;
  /** Which BUs have their own saved override (rather than inheriting). */
  overridden: string[];
  /** True when nothing at all is saved — the built-in defaults are in force. */
  isDefault: boolean;
}

/**
 * Every scoring config in one read.
 *
 * A business unit stores its override under its own key (`usa`, `uk`, …), and
 * `default` is what the rest inherit — so tuning one BU's weights never
 * silently changes another's. Loading them together matters because the
 * scoring pass walks records across every BU and would otherwise issue a query
 * per record.
 *
 * A BU override is merged onto the GLOBAL saved config, not onto the built-in
 * defaults, so a shared change to (say) the phase table still reaches every BU
 * that hasn't overridden it.
 */
export async function getScoringPolicies(): Promise<ScoringPolicySet> {
  const byBu: Record<string, PriorityConfig> = { default: DEFAULT_PRIORITY_CONFIG };
  const overridden: string[] = [];

  try {
    const supabase = configReader();
    const { data, error } = await supabase.from('scoring_policy').select('id, config');
    if (error || !data || data.length === 0) {
      for (const bu of BUSINESS_UNITS) byBu[bu] = DEFAULT_PRIORITY_CONFIG;
      return { byBu, overridden, isDefault: true };
    }

    const rows = data as { id: string; config: unknown }[];
    const globalRow = rows.find((r) => r.id === 'default');
    const globalConfig = globalRow?.config ? mergePriorityConfig(globalRow.config) : DEFAULT_PRIORITY_CONFIG;
    byBu.default = globalConfig;

    for (const bu of BUSINESS_UNITS) {
      const row = rows.find((r) => r.id === bu);
      if (row?.config && Object.keys(row.config as object).length > 0) {
        // Layer the BU's override on top of the global config so partial
        // overrides (just the thresholds, say) keep everything else in sync.
        byBu[bu] = mergePriorityConfig({ ...globalConfig, ...(row.config as object) });
        overridden.push(bu);
      } else {
        byBu[bu] = globalConfig;
      }
    }

    return { byBu, overridden, isDefault: !globalRow && overridden.length === 0 };
  } catch {
    for (const bu of BUSINESS_UNITS) byBu[bu] = DEFAULT_PRIORITY_CONFIG;
    return { byBu, overridden, isDefault: true };
  }
}

/** The config a single record should be scored with. */
export function configForBu(set: ScoringPolicySet, bu: string | null | undefined): PriorityConfig {
  return (bu && set.byBu[bu]) || set.byBu.default;
}
