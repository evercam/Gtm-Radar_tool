import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';

/**
 * The whole configuration of this workspace, as one document.
 *
 * Every knob the app has is already a JSON document in its own table — scoring
 * weights, routing rules, the enrichment policy, per-source schedules and
 * saved queries. They are just spread across nine tables and, for three of
 * them, no screen at all. This gathers them into one file so a configuration
 * can be read, reviewed, diffed against another workspace, kept in git, or
 * handed back as the starting point for the next change.
 *
 * `answers` is reserved for the questionnaire that will generate these
 * bundles. Exported empty today, so a bundle produced by the form and one
 * exported from a running install are the same shape from the start.
 *
 * Read through the service role deliberately: this is admin-gated
 * configuration, and reading it under RLS would return the caller's partial
 * view, which is not what "the current parameters" means.
 */

export const CONFIG_SCHEMA_VERSION = 1;

export interface ConfigBundle {
  schemaVersion: number;
  generatedAt: string;
  generatedBy: string | null;
  workspace: { supabaseUrl: string | null };
  answers: Record<string, unknown>;
  config: {
    scoring: unknown;
    enrichment: unknown;
    routing: unknown;
    assignment: unknown;
    allocation: unknown;
    prioritisation: unknown;
    signIn: { allowedDomains: string[] };
    roster: unknown[];
    sources: Record<string, unknown>;
  };
  /** Tables that could not be read, so a partial export is never mistaken for a complete one. */
  missing: string[];
}

/** Columns that describe intent. Counters and timestamps are state, not configuration. */
const SOURCE_FIELDS = [
  'slug',
  'is_enabled',
  'ingest_mode',
  'schedule_cron',
  'timezone',
  'monthly_request_cap',
  'page_size',
  'max_records_per_run',
  'timeout_ms',
  'rate_limit_per_minute',
  'query_params',
] as const;

const ROSTER_FIELDS = [
  'name',
  'email',
  'role',
  'bu',
  'verticals',
  'regions',
  'preferred_verticals',
  'daily_lead_quota',
  'is_active',
] as const;

export async function exportConfigBundle(generatedBy: string | null): Promise<ConfigBundle> {
  const missing: string[] = [];

  const bundle: ConfigBundle = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy,
    workspace: { supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null },
    answers: {},
    config: {
      scoring: null,
      enrichment: null,
      routing: [],
      assignment: [],
      allocation: null,
      prioritisation: [],
      signIn: { allowedDomains: [] },
      roster: [],
      sources: {},
    },
    missing,
  };

  if (!isSupabaseServiceConfigured()) {
    missing.push('supabase service role not configured — nothing could be read');
    return bundle;
  }

  const db = getServiceSupabase();

  /** One single-row policy document. A table that has never been written is not an error. */
  const single = async (table: string, column: string): Promise<unknown> => {
    const { data, error } = await db.from(table).select(column).eq('id', 'default').maybeSingle();
    if (error) {
      missing.push(table);
      return null;
    }
    return (data as Record<string, unknown> | null)?.[column] ?? null;
  };

  const [scoring, enrichment, routing, assignment, allocation, prioritisation] = await Promise.all([
    single('scoring_policy', 'config'),
    single('enrichment_policy', 'config'),
    single('routing_policy', 'rules'),
    single('assignment_rules', 'rules'),
    single('allocation_policy', 'config'),
    single('enrichment_rules', 'rules'),
  ]);

  bundle.config.scoring = scoring;
  bundle.config.enrichment = enrichment;
  bundle.config.routing = routing ?? [];
  bundle.config.assignment = assignment ?? [];
  bundle.config.allocation = allocation;
  bundle.config.prioritisation = prioritisation ?? [];

  const auth = await db.from('auth_settings').select('allowed_domains').eq('id', 'default').maybeSingle();
  if (auth.error) missing.push('auth_settings');
  else bundle.config.signIn.allowedDomains = (auth.data as { allowed_domains: string[] } | null)?.allowed_domains ?? [];

  // Ordered by slug so two exports of an unchanged workspace are byte-identical
  // and a diff shows only real changes.
  const sources = await db.from('source_config').select(SOURCE_FIELDS.join(',')).order('slug');
  if (sources.error) {
    missing.push('source_config');
  } else {
    for (const row of (sources.data ?? []) as unknown as Record<string, unknown>[]) {
      const { slug, ...rest } = row;
      bundle.config.sources[String(slug)] = rest;
    }
  }

  // The roster carries no ids: a bundle should be importable into another
  // workspace, and an id from this one would mean nothing there. People are
  // matched on email.
  const roster = await db.from('assignees').select(ROSTER_FIELDS.join(',')).order('name');
  if (roster.error) missing.push('assignees');
  else bundle.config.roster = (roster.data ?? []) as unknown[];

  return bundle;
}

/** A filename that sorts chronologically and says which workspace it came from. */
export function bundleFilename(bundle: ConfigBundle): string {
  const ref = bundle.workspace.supabaseUrl?.match(/https:\/\/([a-z0-9]+)\./)?.[1] ?? 'workspace';
  return `source-hub-config-${ref}-${bundle.generatedAt.slice(0, 10)}.json`;
}
