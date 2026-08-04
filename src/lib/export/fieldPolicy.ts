/**
 * Which Apollo custom field each of our fields is written into.
 *
 * `FIELD_MAP` in apolloFields.ts is the built-in default. This makes the target
 * *name* configurable, because two of the seven defaults cannot work in this
 * workspace and no code change fixes that: `Qualify Account` and
 * `evercam_us_project_signal` are modality 'account', so Apollo accepts them on a
 * contact and discards them. Whoever owns the Apollo workspace is the only person
 * who can decide where that content should go instead, and they should not need a
 * deploy to say so.
 *
 * Only the destination is configurable. The SOURCES are fixed — they are the
 * fields the export knows how to produce, and inventing a new one is a code
 * change by definition.
 *
 * `null` is a real, meaningful choice: it means "do not write this anywhere",
 * which is the honest setting for a field that has no contact-level home yet.
 */

import { FIELD_MAP } from './apolloFields';

/** Our field → the Apollo custom field NAME to write it into, or null for off. */
export type ExportFieldPolicy = Record<string, string | null>;

/** Every source the export can produce. Nothing outside this list is accepted. */
export const EXPORT_FIELD_SOURCES = FIELD_MAP.map((f) => f.source);

/** The built-in mapping, as a policy document. */
export const DEFAULT_EXPORT_FIELD_POLICY: ExportFieldPolicy = Object.fromEntries(
  FIELD_MAP.map((f) => [f.source, f.apolloName])
);

/**
 * Saved values merged onto the defaults.
 *
 * An absent key inherits the default; a key present with `null` is an explicit
 * "off" and must NOT fall back — otherwise turning a field off would silently
 * turn itself back on, which is the opposite of a setting.
 */
export function mergeExportFieldPolicy(input: unknown): ExportFieldPolicy {
  const out: ExportFieldPolicy = { ...DEFAULT_EXPORT_FIELD_POLICY };
  if (!input || typeof input !== 'object') return out;

  for (const [source, value] of Object.entries(input as Record<string, unknown>)) {
    // Ignore keys the export cannot produce, so a stale document from an older
    // version cannot inject a mapping nothing will ever read.
    if (!EXPORT_FIELD_SOURCES.includes(source)) continue;
    if (value === null) out[source] = null;
    else if (typeof value === 'string') out[source] = value.trim() || null;
  }
  return out;
}

export interface FieldPolicyValidation {
  ok: boolean;
  policy?: ExportFieldPolicy;
  error?: string;
}

/**
 * Rejects a document that could not do what it claims.
 *
 * The check that earns its place is the duplicate one: two of our fields pointed
 * at the same Apollo field means the second silently overwrites the first, and
 * the export would report seven fields written with six arriving.
 */
export function validateExportFieldPolicy(input: unknown): FieldPolicyValidation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'The field mapping must be an object.' };
  }

  const raw = input as Record<string, unknown>;
  for (const [source, value] of Object.entries(raw)) {
    if (!EXPORT_FIELD_SOURCES.includes(source)) {
      return { ok: false, error: `"${source}" is not a field the export produces.` };
    }
    if (value !== null && typeof value !== 'string') {
      return { ok: false, error: `The target for "${source}" must be a field name, or null to switch it off.` };
    }
  }

  const policy = mergeExportFieldPolicy(input);

  const used = new Map<string, string>();
  for (const [source, target] of Object.entries(policy)) {
    if (!target) continue;
    const clash = used.get(target);
    if (clash) {
      return {
        ok: false,
        error: `"${source}" and "${clash}" both write to "${target}" — one would overwrite the other. Give each its own field, or switch one off.`,
      };
    }
    used.set(target, source);
  }

  return { ok: true, policy };
}

/**
 * The policy as the entries `mapCustomFields` consumes.
 *
 * Sources switched off are dropped here rather than carried through as nulls, so
 * downstream code never has to ask whether a mapping is real.
 */
export function resolveFieldMap(policy: ExportFieldPolicy): { source: string; apolloName: string }[] {
  return FIELD_MAP.filter((f) => policy[f.source]).map((f) => ({
    source: f.source,
    apolloName: policy[f.source] as string,
  }));
}
