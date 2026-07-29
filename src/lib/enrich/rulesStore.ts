import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { DEFAULT_ENRICHMENT_RULES, validateRules, type EnrichmentRule } from './rules';

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

/**
 * Enrichment rules, stored as a single `enrichment_rules` row — the same
 * pattern as routing_policy and scoring_policy. Falls back to the built-in
 * defaults so the selection job works before anything is saved.
 */

export async function getEnrichmentRules(): Promise<{ rules: EnrichmentRule[]; isDefault: boolean }> {
  try {
    const { data, error } = await (
      configReader()
    )
      .from('enrichment_rules')
      .select('rules')
      .eq('id', 'default')
      .maybeSingle();

    if (error || !data?.rules || !Array.isArray(data.rules) || data.rules.length === 0) {
      return { rules: DEFAULT_ENRICHMENT_RULES, isDefault: true };
    }
    return { rules: data.rules as EnrichmentRule[], isDefault: false };
  } catch {
    return { rules: DEFAULT_ENRICHMENT_RULES, isDefault: true };
  }
}

export async function saveEnrichmentRules(input: unknown): Promise<{ ok: boolean; message: string }> {
  if (!isSupabaseServiceConfigured()) {
    return { ok: false, message: 'Supabase service role is not configured.' };
  }

  const validated = validateRules(input);
  if (!validated.ok) return { ok: false, message: validated.error };

  const { error } = await getServiceSupabase()
    .from('enrichment_rules')
    .upsert({ id: 'default', rules: validated.rules }, { onConflict: 'id' });

  if (error) {
    const hint = /schema cache|does not exist/i.test(error.message) ? ' Run the prioritisation migration first.' : '';
    return { ok: false, message: `${error.message}.${hint}` };
  }

  return {
    ok: true,
    message: `Saved ${validated.rules.length} rule${validated.rules.length === 1 ? '' : 's'}. They apply on the next prioritisation run.`,
  };
}

export interface PrioritisationRun {
  id: string;
  trigger: string;
  candidates: number;
  selected: number;
  deferred: number;
  unmatched: number;
  byRule: { ruleId: string; ruleName: string; count: number; overflow: number }[];
  status: string;
  startedAt: string;
  durationMs: number | null;
}

export async function getPrioritisationRuns(limit = 10): Promise<PrioritisationRun[]> {
  try {
    const { data, error } = await (
      configReader()
    )
      .from('prioritisation_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) return [];

    return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      trigger: (r.trigger as string) ?? 'manual',
      candidates: (r.candidates as number) ?? 0,
      selected: (r.selected as number) ?? 0,
      deferred: (r.deferred as number) ?? 0,
      unmatched: (r.unmatched as number) ?? 0,
      byRule: (r.by_rule as PrioritisationRun['byRule']) ?? [],
      status: (r.status as string) ?? 'completed',
      startedAt: r.started_at as string,
      durationMs: (r.duration_ms as number) ?? null,
    }));
  } catch {
    return [];
  }
}
