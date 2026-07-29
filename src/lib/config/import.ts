import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { validateAssignmentRules } from '@/lib/assignment';
import { validateAllocationPolicy } from '@/lib/allocation';
import { validateRules as validateRoutingRules } from '@/lib/routing';
import { BUSINESS_UNITS, VERTICALS } from '@/lib/semantics';
import { CONFIG_SCHEMA_VERSION } from './bundle';

/**
 * Applying a configuration bundle.
 *
 * Nothing here re-implements a rule. Every section goes through the validator
 * the app already uses for that table, so an imported configuration cannot be
 * looser than one typed into a form — the difference is only how it arrived.
 *
 * Two things this is careful about:
 *
 *   * A section absent from the bundle is LEFT ALONE, never cleared. A
 *     questionnaire that covers assignment must not silently wipe scoring.
 *     Present-but-empty (`[]`) is a deliberate "no rules" and is honoured.
 *   * Nothing is written until every section validates. A half-applied
 *     configuration is worse than a rejected one: assignment rules pointing at
 *     a roster that did not load will quietly assign nothing.
 */

/** Sections this importer understands. Anything else is reported, never ignored. */
export const SUPPORTED = ['assignment', 'allocation', 'routing', 'roster'] as const;
export type SupportedSection = (typeof SUPPORTED)[number];

export interface SectionPlan {
  section: string;
  supported: boolean;
  present: boolean;
  /** Human-readable before → after, so a dry run is reviewable without diffing JSON. */
  summary: string;
  warnings: string[];
}

export interface ImportPlan {
  ok: boolean;
  error?: string;
  sections: SectionPlan[];
  warnings: string[];
}

interface RosterEntry {
  name: string;
  email?: string | null;
  role?: string;
  bu?: string[];
  verticals?: string[];
  regions?: string[];
  preferred_verticals?: string[];
  daily_lead_quota?: number;
  is_active?: boolean;
}

const ROLES = ['bdr', 'sdr', 'ae', 'marketing', 'sales_manager', 'admin'];

/**
 * The roster has no validator of its own — `saveAssignee` validates one person
 * at a time and tolerates partials, which is right for a form and wrong for a
 * file that replaces a team.
 */
function validateRoster(input: unknown): { ok: true; roster: RosterEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'Roster must be an array.' };

  const seen = new Set<string>();
  const roster: RosterEntry[] = [];

  for (const [i, raw] of input.entries()) {
    const at = `Person ${i + 1}`;
    if (!raw || typeof raw !== 'object') return { ok: false, error: `${at}: not an object.` };
    const p = raw as RosterEntry;

    if (typeof p.name !== 'string' || !p.name.trim()) return { ok: false, error: `${at}: a name is required.` };

    // Email is the join key on import — two people sharing one would make the
    // second silently overwrite the first.
    const key = (p.email ?? '').trim().toLowerCase();
    if (key) {
      if (seen.has(key)) return { ok: false, error: `${at}: ${key} appears more than once.` };
      seen.add(key);
    }

    if (p.role !== undefined && !ROLES.includes(p.role)) {
      return { ok: false, error: `${at}: role must be one of ${ROLES.join(', ')}.` };
    }
    if (p.daily_lead_quota !== undefined) {
      const q = p.daily_lead_quota;
      if (!Number.isInteger(q) || q < 0 || q > 1000) {
        return { ok: false, error: `${at}: daily_lead_quota must be a whole number between 0 and 1000.` };
      }
    }
    for (const field of ['bu', 'verticals', 'regions', 'preferred_verticals'] as const) {
      const v = p[field];
      if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) {
        return { ok: false, error: `${at}: ${field} must be a list of strings.` };
      }
    }
    roster.push(p);
  }
  return { ok: true, roster };
}

/**
 * Values that are legal as strings but match nothing in this database.
 *
 * The reason this exists: business units are stored as slugs (`usa`, `ireland`)
 * while people write them as codes (`US`, `IE`). A rule scoped to `"US"` is
 * perfectly valid JSON, passes every type check, and then never matches a
 * single lead — which reads as "assignment is broken" rather than as a typo.
 */
function checkVocabulary(bundle: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const bus = new Set<string>(BUSINESS_UNITS as readonly string[]);
  const verticals = new Set<string>(VERTICALS as readonly string[]);

  const seenBu = new Set<string>();
  const seenVertical = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === 'bu' || k === 'businessUnit') && Array.isArray(v)) {
        for (const x of v) if (typeof x === 'string' && !bus.has(x)) seenBu.add(x);
      }
      if ((k === 'vertical' || k === 'verticals' || k === 'preferred_verticals') && Array.isArray(v)) {
        for (const x of v) if (typeof x === 'string' && !verticals.has(x)) seenVertical.add(x);
      }
      walk(v);
    }
  };
  walk(bundle);

  if (seenBu.size > 0) {
    warnings.push(
      `Unknown business unit(s): ${[...seenBu].join(', ')}. Valid values are ${[...bus].join(', ')} — rules using anything else will match no leads.`
    );
  }
  if (seenVertical.size > 0) {
    warnings.push(
      `Unknown vertical(s): ${[...seenVertical].join(', ')}. Rules using them will match no leads.`
    );
  }
  return warnings;
}

/** Validates the whole bundle and describes what applying it would do. */
export async function planImport(input: unknown): Promise<ImportPlan> {
  const empty: SectionPlan[] = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'That file is not a configuration bundle.', sections: empty, warnings: [] };
  }
  const bundle = input as Record<string, unknown>;

  const version = bundle.schemaVersion;
  if (typeof version !== 'number') {
    return { ok: false, error: 'Missing schemaVersion — is this a Source Hub configuration file?', sections: empty, warnings: [] };
  }
  if (version > CONFIG_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `This file is version ${version}; this install understands up to ${CONFIG_SCHEMA_VERSION}. Update the app first.`,
      sections: empty,
      warnings: [],
    };
  }

  const config = (bundle.config ?? {}) as Record<string, unknown>;
  if (typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, error: 'The `config` block is missing or malformed.', sections: empty, warnings: [] };
  }

  const sections: SectionPlan[] = [];
  const warnings = checkVocabulary(config);

  const current = await readCurrent();

  for (const name of Object.keys(config)) {
    if (!(SUPPORTED as readonly string[]).includes(name)) {
      sections.push({
        section: name,
        supported: false,
        present: true,
        summary: 'Skipped — this importer does not apply this section yet. Nothing will change.',
        warnings: [],
      });
    }
  }

  // --- assignment -----------------------------------------------------------
  if ('assignment' in config) {
    const v = validateAssignmentRules(config.assignment);
    if (!v.ok) return { ok: false, error: `Assignment rules: ${v.error}`, sections, warnings };

    const enabled = v.rules.filter((r) => r.enabled !== false).length;
    const unreachable = v.rules.filter((r) => !r.toUserId && !r.toRole).length;
    sections.push({
      section: 'assignment',
      supported: true,
      present: true,
      summary: `${current.assignment} rule(s) → ${v.rules.length} (${enabled} enabled)`,
      warnings: unreachable > 0 ? [`${unreachable} rule(s) name nobody to assign to and will never place a lead.`] : [],
    });
  }

  // --- allocation -----------------------------------------------------------
  if ('allocation' in config && config.allocation !== null) {
    const v = validateAllocationPolicy(config.allocation);
    if (!v.ok) return { ok: false, error: `Lead mix: ${v.error}`, sections, warnings };

    const shares = Object.entries(v.policy.shares ?? {});
    const total = shares.reduce((s, [, n]) => s + (n as number), 0);
    const w: string[] = [];
    // Shares are percentages of capacity, not weights — under 100 leaves the
    // remainder to priority order, which is legal but rarely intended.
    if (shares.length > 0 && total < 100 && !v.policy.fillRemainder) {
      w.push(`Shares total ${total}% and fillRemainder is off — ${100 - total}% of daily capacity goes unused.`);
    }
    sections.push({
      section: 'allocation',
      supported: true,
      present: true,
      summary: current.allocation
        ? `mode ${v.policy.mode}, by ${v.policy.dimension}, ${shares.length} bucket(s), cap ${v.policy.dailyCap ?? 'none'}`
        : `first time configured — mode ${v.policy.mode}, by ${v.policy.dimension}, ${shares.length} bucket(s)`,
      warnings: w,
    });
  }

  // --- routing --------------------------------------------------------------
  if ('routing' in config) {
    const v = validateRoutingRules(config.routing);
    if (!v.ok) return { ok: false, error: `Routing rules: ${v.error}`, sections, warnings };
    sections.push({
      section: 'routing',
      supported: true,
      present: true,
      summary: `${current.routing} rule(s) → ${v.rules.length}`,
      warnings: [],
    });
  }

  // --- roster ---------------------------------------------------------------
  if ('roster' in config) {
    const v = validateRoster(config.roster);
    if (!v.ok) return { ok: false, error: `Roster: ${v.error}`, sections, warnings };

    const withoutEmail = v.roster.filter((p) => !p.email?.trim()).length;
    const w: string[] = [];
    if (withoutEmail > 0) {
      w.push(
        `${withoutEmail} person/people have no email. They will be added as new entries every import, and the Apollo export cannot attach an owner to their leads.`
      );
    }
    const capacity = v.roster
      .filter((p) => p.is_active !== false)
      .reduce((s, p) => s + (p.daily_lead_quota ?? 50), 0);
    sections.push({
      section: 'roster',
      supported: true,
      present: true,
      summary: `${current.roster} person/people → ${v.roster.length}, total daily capacity ${capacity}`,
      warnings: w,
    });
  }

  if (sections.filter((s) => s.supported).length === 0) {
    return { ok: false, error: 'Nothing to apply — the file contains no section this importer handles.', sections, warnings };
  }

  return { ok: true, sections, warnings };
}

async function readCurrent(): Promise<{ assignment: number; allocation: boolean; routing: number; roster: number }> {
  if (!isSupabaseServiceConfigured()) return { assignment: 0, allocation: false, routing: 0, roster: 0 };
  const db = getServiceSupabase();

  const [a, al, r, ro] = await Promise.all([
    db.from('assignment_rules').select('rules').eq('id', 'default').maybeSingle(),
    db.from('allocation_policy').select('config').eq('id', 'default').maybeSingle(),
    db.from('routing_policy').select('rules').eq('id', 'default').maybeSingle(),
    db.from('assignees').select('id', { count: 'exact', head: true }),
  ]);

  return {
    assignment: ((a.data as { rules?: unknown[] } | null)?.rules ?? []).length,
    allocation: Boolean((al.data as { config?: Record<string, unknown> } | null)?.config),
    routing: ((r.data as { rules?: unknown[] } | null)?.rules ?? []).length,
    roster: ro.count ?? 0,
  };
}

/**
 * Applies a bundle that has already been planned.
 *
 * Validation runs again rather than trusting the plan: the two calls are
 * separate HTTP requests, and the body of the second is not necessarily the
 * body of the first.
 */
export async function applyImport(
  input: unknown
): Promise<{ ok: boolean; message: string; applied: string[] }> {
  const plan = await planImport(input);
  if (!plan.ok) return { ok: false, message: plan.error ?? 'Invalid bundle.', applied: [] };
  if (!isSupabaseServiceConfigured()) {
    return { ok: false, message: 'Supabase service role is not configured.', applied: [] };
  }

  const db = getServiceSupabase();
  const config = ((input as Record<string, unknown>).config ?? {}) as Record<string, unknown>;
  const applied: string[] = [];

  if ('assignment' in config) {
    const v = validateAssignmentRules(config.assignment);
    if (!v.ok) return { ok: false, message: `Assignment rules: ${v.error}`, applied };
    const { error } = await db.from('assignment_rules').upsert({ id: 'default', rules: v.rules }, { onConflict: 'id' });
    if (error) return { ok: false, message: `Assignment rules: ${error.message}`, applied };
    applied.push(`${v.rules.length} assignment rule(s)`);
  }

  if ('allocation' in config && config.allocation !== null) {
    const v = validateAllocationPolicy(config.allocation);
    if (!v.ok) return { ok: false, message: `Lead mix: ${v.error}`, applied };
    const { error } = await db.from('allocation_policy').upsert({ id: 'default', config: v.policy }, { onConflict: 'id' });
    if (error) return { ok: false, message: `Lead mix: ${error.message}`, applied };
    applied.push('lead mix');
  }

  if ('routing' in config) {
    const v = validateRoutingRules(config.routing);
    if (!v.ok) return { ok: false, message: `Routing rules: ${v.error}`, applied };
    const { error } = await db.from('routing_policy').upsert({ id: 'default', rules: v.rules }, { onConflict: 'id' });
    if (error) return { ok: false, message: `Routing rules: ${error.message}`, applied };
    applied.push(`${v.rules.length} routing rule(s)`);
  }

  if ('roster' in config) {
    const v = validateRoster(config.roster);
    if (!v.ok) return { ok: false, message: `Roster: ${v.error}`, applied };

    // Matched on email, never replaced wholesale: an assignee id is referenced
    // by every lead that person owns, so deleting and re-inserting the roster
    // would orphan their book.
    const { data: existing } = await db.from('assignees').select('id, email');
    const byEmail = new Map(
      ((existing ?? []) as { id: string; email: string | null }[])
        .filter((r) => r.email)
        .map((r) => [r.email!.toLowerCase(), r.id])
    );

    for (const p of v.roster) {
      const row = {
        name: p.name.trim(),
        email: p.email?.trim().toLowerCase() || null,
        role: p.role ?? 'bdr',
        bu: p.bu ?? [],
        verticals: p.verticals ?? [],
        regions: p.regions ?? [],
        preferred_verticals: p.preferred_verticals ?? [],
        daily_lead_quota: p.daily_lead_quota ?? 50,
        is_active: p.is_active ?? true,
      };
      const id = row.email ? byEmail.get(row.email) : undefined;
      const { error } = id
        ? await db.from('assignees').update(row).eq('id', id)
        : await db.from('assignees').insert(row);
      if (error) return { ok: false, message: `Roster (${row.name}): ${error.message}`, applied };
    }
    applied.push(`${v.roster.length} roster entr${v.roster.length === 1 ? 'y' : 'ies'}`);
  }

  return { ok: true, message: `Applied ${applied.join(', ')}.`, applied };
}
