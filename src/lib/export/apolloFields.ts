import 'server-only';
import { readSecret } from '@/lib/crypto/store';

/**
 * Putting our data into the custom fields this workspace already has.
 *
 * Apollo has no concept of a construction project, so everything that makes a
 * lead worth calling — the project name, the phase, the opening hook, the
 * call script — has nowhere to go in the standard contact shape. This
 * workspace has already solved that: 26 custom fields exist, several of them
 * named for exactly this data.
 *
 * Mapped by NAME rather than by id. Custom-field ids are opaque and per
 * workspace, so a hardcoded id is a silent mismatch the day someone rebuilds
 * a field; a name is legible and survives it. Ids are resolved once at
 * runtime and cached for the process.
 *
 * Only free-text fields are written. Picklists reject a value that is not one
 * of their options, and writing a valid-looking string into one fails the
 * whole contact — so `Lead Source`, `Industry Fit` and the rest are read but
 * never written until someone tells us their allowed values.
 *
 * Two properties of a field decide whether a write can land at all, and both
 * come straight from Apollo rather than being guessed:
 *
 *   modality             what the field hangs off — 'contact', 'account' or
 *                        'user'. Only 'contact' can be written on a contact;
 *                        the others are accepted into the payload and then
 *                        silently ignored, which is how `Qualify Account` was
 *                        being "sent" every run and never appearing.
 *
 *   text_field_max_length the hard ceiling. `Job Title` allows 30 characters,
 *                        and one over is not a truncated value but an HTTP 422
 *                        that fails the ENTIRE batch of up to 100 contacts.
 *                        26% of titles on file are longer than 30.
 */

const BASE = 'https://api.apollo.io';

export interface CustomFieldDef {
  id: string;
  name: string;
  type: string;
  /** 'contact' | 'account' | 'user' — only 'contact' is writable on a contact. */
  modality: string | null;
  /** Apollo's hard character ceiling, or null when the field has none. */
  maxLength: number | null;
}

let cache: CustomFieldDef[] | null = null;

export async function loadCustomFields(force = false): Promise<CustomFieldDef[]> {
  if (cache && !force) return cache;
  const apiKey = await readSecret('apollo_api_key');
  if (!apiKey) return [];

  try {
    const res = await fetch(`${BASE}/api/v1/typed_custom_fields`, {
      headers: { Accept: 'application/json', 'x-api-key': apiKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      typed_custom_fields?: {
        id?: string;
        name?: string;
        type?: string;
        modality?: string;
        text_field_max_length?: number | null;
      }[];
    };
    cache = (json.typed_custom_fields ?? [])
      .filter((f) => f.id && f.name)
      .map((f) => ({
        id: f.id!,
        name: f.name!,
        type: f.type ?? 'string',
        modality: f.modality ?? null,
        maxLength: typeof f.text_field_max_length === 'number' ? f.text_field_max_length : null,
      }));
    return cache;
  } catch {
    return [];
  }
}

/** Types that accept arbitrary text. Anything else is left alone. */
const WRITABLE = new Set(['string', 'textarea', 'text']);

/**
 * Our field → the custom field name to write it into.
 *
 * `Project Name` appears twice in this workspace with different ids. They are
 * NOT interchangeable: `6983b5de…` has modality 'user' and `693973c1…` has
 * modality 'contact'. Preferring "the first writable match" picked the user one,
 * so the project name was accepted and silently discarded on every export.
 * Modality now decides, which makes the choice correct rather than lucky.
 *
 * `Qualify Account` and `evercam_us_project_signal` are modality 'account'.
 * They cannot be written on a contact at all, so they are reported as
 * unsupported instead of being sent into the void — see `MappedFields`.
 */
export const FIELD_MAP: { source: string; apolloName: string; describe: string }[] = [
  { source: 'canonical_name', apolloName: 'Project Name', describe: 'The project this lead came from' },
  { source: 'project_summary', apolloName: 'Active account project name', describe: 'Project, phase and value in one line' },
  { source: 'call_prep_summary', apolloName: 'Cold Call Script 4641', describe: 'The brief a rep reads before dialling' },
  { source: 'qualify_account', apolloName: 'Qualify Account', describe: 'Why this account fits, and the trigger' },
  { source: 'qualify_contact', apolloName: 'Qualify Contact', describe: 'Why this person, and the opening hook' },
  { source: 'project_signal', apolloName: 'evercam_us_project_signal', describe: 'The signal that surfaced this record' },
  { source: 'contact_title', apolloName: 'Job Title', describe: 'Title as published' },
  /**
   * The whole record, rendered.
   *
   * The seven fields above are a summary; this is everything the tool holds —
   * description, priority and why, location, timing, scale, the full committee,
   * and the link back to the source. All of it was already in the database and
   * none of it reached a rep, who had to come back to the tool for any question
   * the summary did not answer.
   *
   * Its target does not exist in the workspace by default: this is a new field,
   * and the export reports it as unmatched until somebody creates it and points
   * this at it — which is exactly what the Settings mapping is for.
   */
  { source: 'record_brief', apolloName: 'Evercam Project Brief', describe: 'Everything the tool holds, as a briefing' },
];

export interface MappedFields {
  /** typed_custom_fields payload, keyed by Apollo field id. */
  values: Record<string, string>;
  /** Names that could not be matched, so a missing field is visible not silent. */
  unmatched: string[];
  /** Names defined more than once — the contact-modality one was used. */
  duplicated: string[];
  /**
   * Names that exist but cannot live on a contact, with the modality that owns
   * them. These are dropped deliberately: sending them costs a field that never
   * arrives, and reporting them is the only way anyone finds out.
   */
  unsupported: { name: string; modality: string }[];
  /** Values cut to Apollo's ceiling, so a shortened field is never a surprise. */
  truncated: { name: string; from: number; to: number }[];
}

/**
 * Build the typed_custom_fields payload for one contact.
 *
 * `mapping` overrides where each field is written — it comes from the
 * `export_field_policy` document that Settings edits. It defaults to `FIELD_MAP`
 * so a caller with no policy loaded (a script, a test) behaves exactly as before.
 */
export async function mapCustomFields(
  values: Record<string, string | null | undefined>,
  mapping: { source: string; apolloName: string }[] = FIELD_MAP
): Promise<MappedFields> {
  const defs = await loadCustomFields();
  const out: Record<string, string> = {};
  const unmatched: string[] = [];
  const duplicated: string[] = [];
  const unsupported: { name: string; modality: string }[] = [];
  const truncated: { name: string; from: number; to: number }[] = [];

  for (const { source, apolloName } of mapping) {
    const value = values[source];
    if (!value?.trim()) continue;

    const matches = defs.filter((d) => d.name === apolloName);
    if (matches.length === 0) {
      unmatched.push(apolloName);
      continue;
    }

    // Only a contact-modality field can be written on a contact. Anything else
    // is accepted by the API and then dropped, so refuse to pretend.
    const onContact = matches.filter((d) => d.modality === 'contact');
    if (onContact.length === 0) {
      unsupported.push({ name: apolloName, modality: matches[0].modality ?? 'unknown' });
      continue;
    }
    if (onContact.length > 1) duplicated.push(apolloName);

    const def = onContact.find((d) => WRITABLE.has(d.type)) ?? onContact[0];
    if (!WRITABLE.has(def.type)) continue; // a picklist would reject the whole contact

    // One character over the ceiling is a 422 that fails the whole batch, not a
    // rejected field. Truncating here is what keeps 99 good contacts moving.
    const text = value.trim();
    if (def.maxLength != null && text.length > def.maxLength) {
      truncated.push({ name: def.name, from: text.length, to: def.maxLength });
      out[def.id] = text.slice(0, def.maxLength);
    } else {
      out[def.id] = text;
    }
  }

  return { values: out, unmatched, duplicated, unsupported, truncated };
}

/**
 * The one-line project summary Apollo has no field for.
 * "Semiconductor Fab · Under Construction · $1.5B"
 */
export function projectSummary(r: {
  project_type?: string | null;
  current_phase?: string | null;
  estimated_value?: number | null;
}): string | null {
  const bits = [r.project_type, r.current_phase].filter(Boolean) as string[];
  if (r.estimated_value) {
    const v = r.estimated_value;
    bits.push(v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${Math.round(v / 1e6)}M` : `$${v.toLocaleString()}`);
  }
  return bits.length ? bits.join(' · ') : null;
}

/** Why this account is worth a call, in the words the tool already produced. */
export function qualifyAccount(r: {
  icp_fit_score?: number | null;
  icp_fit_reason?: string | null;
  trigger_event?: string | null;
  pain_point?: string | null;
}): string | null {
  const bits: string[] = [];
  if (r.icp_fit_score != null) bits.push(`ICP fit ${r.icp_fit_score}/100${r.icp_fit_reason ? ` — ${r.icp_fit_reason}` : ''}`);
  if (r.trigger_event) bits.push(`Trigger: ${r.trigger_event}`);
  if (r.pain_point) bits.push(`Pain: ${r.pain_point}`);
  return bits.length ? bits.join('\n') : null;
}

/**
 * Why this person, and how to open.
 *
 * `roleOverride` exists because a committee is not one person. `contact_role` is
 * the LEAD's column, so building this straight from the record stamped the
 * primary contact's buying role onto every additional contact — a BIM Manager
 * and a Construction Director both read "Buying role: economic". The caller
 * classifies each person's own title and passes it here; the record's column is
 * only the fallback, and only for the primary.
 */
export function qualifyContact(
  r: {
    contact_role?: string | null;
    opening_hook?: string | null;
    value_angle?: string | null;
  },
  roleOverride?: string | null
): string | null {
  const bits: string[] = [];
  const role = roleOverride !== undefined ? roleOverride : r.contact_role;
  if (role) bits.push(`Buying role: ${role.replace(/_/g, ' ')}`);
  if (r.opening_hook) bits.push(`Opening: ${r.opening_hook}`);
  if (r.value_angle) bits.push(`Angle: ${r.value_angle}`);
  return bits.length ? bits.join('\n') : null;
}
