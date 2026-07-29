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
 */

const BASE = 'https://api.apollo.io';

export interface CustomFieldDef {
  id: string;
  name: string;
  type: string;
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
    const json = (await res.json()) as { typed_custom_fields?: { id?: string; name?: string; type?: string }[] };
    cache = (json.typed_custom_fields ?? [])
      .filter((f) => f.id && f.name)
      .map((f) => ({ id: f.id!, name: f.name!, type: f.type ?? 'string' }));
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
 * `Project Name` appears twice in this workspace with different ids. The first
 * match wins and which one that is gets reported, rather than the export
 * silently writing to whichever came back first.
 */
export const FIELD_MAP: { source: string; apolloName: string; describe: string }[] = [
  { source: 'canonical_name', apolloName: 'Project Name', describe: 'The project this lead came from' },
  { source: 'project_summary', apolloName: 'Active account project name', describe: 'Project, phase and value in one line' },
  { source: 'call_prep_summary', apolloName: 'Cold Call Script 4641', describe: 'The brief a rep reads before dialling' },
  { source: 'qualify_account', apolloName: 'Qualify Account', describe: 'Why this account fits, and the trigger' },
  { source: 'qualify_contact', apolloName: 'Qualify Contact', describe: 'Why this person, and the opening hook' },
  { source: 'project_signal', apolloName: 'evercam_us_project_signal', describe: 'The signal that surfaced this record' },
  { source: 'contact_title', apolloName: 'Job Title', describe: 'Title as published' },
];

export interface MappedFields {
  /** typed_custom_fields payload, keyed by Apollo field id. */
  values: Record<string, string>;
  /** Names that could not be matched, so a missing field is visible not silent. */
  unmatched: string[];
  /** Names defined more than once — the first was used. */
  duplicated: string[];
}

/** Build the typed_custom_fields payload for one contact. */
export async function mapCustomFields(values: Record<string, string | null | undefined>): Promise<MappedFields> {
  const defs = await loadCustomFields();
  const out: Record<string, string> = {};
  const unmatched: string[] = [];
  const duplicated: string[] = [];

  for (const { source, apolloName } of FIELD_MAP) {
    const value = values[source];
    if (!value?.trim()) continue;

    const matches = defs.filter((d) => d.name === apolloName);
    if (matches.length === 0) {
      unmatched.push(apolloName);
      continue;
    }
    if (matches.length > 1) duplicated.push(apolloName);

    const def = matches.find((d) => WRITABLE.has(d.type)) ?? matches[0];
    if (!WRITABLE.has(def.type)) continue; // a picklist would reject the whole contact
    out[def.id] = value.trim();
  }

  return { values: out, unmatched, duplicated };
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

/** Why this person, and how to open. */
export function qualifyContact(r: {
  contact_role?: string | null;
  opening_hook?: string | null;
  value_angle?: string | null;
}): string | null {
  const bits: string[] = [];
  if (r.contact_role) bits.push(`Buying role: ${r.contact_role.replace(/_/g, ' ')}`);
  if (r.opening_hook) bits.push(`Opening: ${r.opening_hook}`);
  if (r.value_angle) bits.push(`Angle: ${r.value_angle}`);
  return bits.length ? bits.join('\n') : null;
}
