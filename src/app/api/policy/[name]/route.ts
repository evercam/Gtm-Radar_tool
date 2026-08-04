import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { validatePriorityConfig, DEFAULT_PRIORITY_CONFIG } from '@/lib/priority';
import { validateEnrichmentPolicy, DEFAULT_ENRICHMENT_POLICY } from '@/lib/enrich/policy';
import { validateExportFieldPolicy, DEFAULT_EXPORT_FIELD_POLICY } from '@/lib/export/fieldPolicy';
import { checkPermission } from '@/lib/auth/session';
import type { Permission } from '@/lib/auth/roles';

export const dynamic = 'force-dynamic';

/**
 * POST /api/policy/[name] — save an admin-parameterized policy.
 *
 *   scoring    → scoring_policy    (lib/priority.ts PriorityConfig)
 *   enrichment → enrichment_policy (lib/enrich/policy.ts EnrichmentPolicy)
 *
 * Each is validated against its own rules before it lands, so a bad edit is
 * rejected with a reason rather than silently scoring everything zero.
 * Routing rules keep their own endpoint (/api/routing/save) because they are a
 * rule LIST rather than a config object.
 */
const POLICIES = {
  scoring: {
    table: 'scoring_policy',
    validate: (input: unknown) => {
      const v = validatePriorityConfig(input);
      return v.ok ? { ok: true as const, value: v.config } : { ok: false as const, error: v.error };
    },
    defaults: DEFAULT_PRIORITY_CONFIG as unknown,
    label: 'Scoring parameters',
    applyHint: 'Re-run "Score & route all" on /routing to apply it to existing records.',
    migration: 'priority_and_enrichment_runs',
    permission: 'scoring.edit' as Permission,
  },
  enrichment: {
    table: 'enrichment_policy',
    validate: (input: unknown) => {
      const v = validateEnrichmentPolicy(input);
      return v.ok ? { ok: true as const, value: v.policy } : { ok: false as const, error: v.error };
    },
    defaults: DEFAULT_ENRICHMENT_POLICY as unknown,
    label: 'Enrichment policy',
    applyHint: 'It takes effect on the next enrichment run.',
    migration: 'priority_and_enrichment_runs',
    permission: 'settings.manage' as Permission,
  },
  'export-fields': {
    table: 'export_field_policy',
    validate: (input: unknown) => {
      const v = validateExportFieldPolicy(input);
      return v.ok ? { ok: true as const, value: v.policy } : { ok: false as const, error: v.error };
    },
    defaults: DEFAULT_EXPORT_FIELD_POLICY as unknown,
    label: 'Apollo field mapping',
    // Nothing to rebuild: the mapping is read per contact as the payload is
    // assembled, so the next export uses it and already-sent contacts are
    // untouched.
    applyHint: 'The next export uses it. Contacts already in Apollo are not rewritten.',
    migration: 'export_field_policy',
    permission: 'settings.manage' as Permission,
  },
} as const;

export async function POST(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  const policy = POLICIES[name as keyof typeof POLICIES];
  if (!policy) {
    return NextResponse.json({ ok: false, message: `Unknown policy "${name}".` }, { status: 404 });
  }

  const auth = await checkPermission(policy.permission);
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: false, message: 'Supabase service key not configured.' }, { status: 200 });
  }

  let body: { config?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON.' }, { status: 400 });
  }

  const validated = policy.validate(body.config);
  if (!validated.ok) return NextResponse.json({ ok: false, message: validated.error }, { status: 200 });

  const supabase = getServiceSupabase();
  const { error } = await supabase
    .from(policy.table)
    .upsert({ id: 'default', config: validated.value }, { onConflict: 'id' });
  if (error) {
    // Names THIS policy's migration. A shared hint pointed everyone at
    // priority_and_enrichment_runs, which does not create every policy table —
    // so the one instruction given was the one that could not help.
    const hint = /schema cache|does not exist/i.test(error.message)
      ? ` Run the ${policy.migration} migration first.`
      : '';
    return NextResponse.json({ ok: false, message: `Could not save: ${error.message}.${hint}` }, { status: 200 });
  }

  return NextResponse.json({
    ok: true,
    // Per-policy, because the next step genuinely differs. Telling someone to
    // re-score after changing a field mapping sends them to rebuild 20,000 rows
    // for a change that only affects the next export.
    message: `${policy.label} saved. ${policy.applyHint}`,
  });
}
