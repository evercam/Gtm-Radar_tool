import type { EnrichedAccount, EnrichedContact } from '@/lib/enrich/types';

/** Where a column's value came from. */
export type Origin = 'source' | 'claude' | 'apollo' | 'gleif';

export const ORIGIN_LABEL: Record<Origin, string> = {
  source: 'Source',
  claude: 'Claude',
  apollo: 'Apollo',
  gleif: 'GLEIF',
};

/**
 * Columns whose origin we track and show to the user. These are the meaningful
 * account/contact/commercial fields — the ones a source may provide and
 * enrichment may fill.
 */
export const TRACKED_PROVENANCE_FIELDS = [
  'company_name_raw',
  'company_website',
  'company_domain',
  'contact_name',
  'contact_title',
  'contact_email',
  'contact_phone',
  'estimated_value',
  'description',
  'project_url',
] as const;

function present(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

/** Origin map for a freshly-normalized record: every populated tracked field is 'source'. */
export function sourceProvenance(rec: Record<string, unknown>): Record<string, Origin> {
  const out: Record<string, Origin> = {};
  for (const f of TRACKED_PROVENANCE_FIELDS) if (present(rec[f])) out[f] = 'source';
  return out;
}

export interface AppliedField {
  field: string;
  origin: Origin;
  value: unknown;
}

export interface EnrichmentApply {
  /** columns to write (only ones that were empty) */
  updates: Record<string, unknown>;
  /** column -> engine that filled it */
  provenance: Record<string, Origin>;
  /** ordered list for display: what enrichment added */
  fieldsAdded: AppliedField[];
}

/**
 * Plan how an enrichment result maps onto columns, filling ONLY empty ones so
 * source values are preserved. Account website/domain/name come from Claude;
 * contact fields carry the contact's own source ('apollo' | 'claude').
 */
export function planEnrichmentApply(
  current: Record<string, unknown>,
  account: EnrichedAccount | null,
  topContact: EnrichedContact | null
): EnrichmentApply {
  const updates: Record<string, unknown> = {};
  const provenance: Record<string, Origin> = {};
  const fieldsAdded: AppliedField[] = [];

  const fillEmpty = (field: string, value: unknown, origin: Origin) => {
    if (!present(value)) return;
    if (present(current[field])) return; // keep the source value — never overwrite
    updates[field] = value;
    provenance[field] = origin;
    fieldsAdded.push({ field, origin, value });
  };

  if (account) {
    fillEmpty('company_website', account.website, 'claude');
    fillEmpty('company_domain', account.domain, 'claude');
    fillEmpty('company_name_raw', account.name, 'claude');
  }
  if (topContact) {
    const origin: Origin = topContact.source === 'apollo' ? 'apollo' : 'claude';
    fillEmpty('contact_name', topContact.name, origin);
    fillEmpty('contact_title', topContact.title, origin);
    fillEmpty('contact_email', topContact.email, origin);
    fillEmpty('contact_phone', topContact.phone, origin);
    // Both providers return this and it was being dropped. It is on the LDR
    // checklist for a reason: it is how a BDR confirms the person is still in
    // the role we think they are before spending a call.
    fillEmpty('contact_linkedin_url', topContact.linkedin_url, origin);
  }

  // The company switchboard, last. It runs after the contact so a person's own
  // number always wins, and it only applies when nothing else supplied one —
  // a main line that reaches reception is worth far more than a blank field
  // when the alternative is a lead nobody can call.
  if (account?.phone) {
    fillEmpty('contact_phone', account.phone, 'apollo');
  }

  return { updates, provenance, fieldsAdded };
}
