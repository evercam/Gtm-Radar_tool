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

/** Apollo's search endpoint returns "Ki***a" until an address is revealed. */
function isObfuscated(name: unknown): boolean {
  return typeof name === 'string' && name.includes('*');
}

/** A name reduced to what can be compared when one side may be masked. */
function nameKey(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const n = name.toLowerCase().replace(/\s+/g, ' ').trim();
  return n.length ? n : null;
}

/**
 * Is the person already on the record the same one enrichment just found?
 *
 *   'empty'     — no contact yet; the whole person can land
 *   'same'      — provably the same human; gaps may be filled
 *   'different' — somebody else, OR not provable. Leave the block alone.
 *
 * "Not provable" deliberately falls to 'different'. Being wrong in that
 * direction leaves a record short of an address; being wrong in the other
 * direction puts a real address beside the wrong person's name, which nothing
 * downstream can detect and a seller acts on.
 */
function identifyPerson(
  current: Record<string, unknown>,
  contact: EnrichedContact
): 'empty' | 'same' | 'different' {
  const curName = nameKey(current.contact_name);
  const curEmail = nameKey(current.contact_email);
  if (!curName && !curEmail) return 'empty';

  // An address identifies a person outright, so it settles the question.
  const newEmail = nameKey(contact.email);
  if (curEmail && newEmail) return curEmail === newEmail ? 'same' : 'different';

  const newName = nameKey(contact.name);
  if (curName && newName) {
    if (curName === newName) return 'same';
    // One side masked: "chris me***r" against "Chris Meyer". Apollo masks from a
    // fixed point, so the visible prefix is real and a prefix match on a name
    // long enough to be distinctive is sound. Short prefixes are not — "j***n"
    // matches half a company — so they stay 'different'.
    const masked = isObfuscated(curName) ? curName : isObfuscated(newName) ? newName : null;
    const plain = masked === curName ? newName : curName;
    if (masked && plain && !isObfuscated(plain)) {
      const prefix = masked.slice(0, masked.indexOf('*'));
      if (prefix.length >= 4 && plain.startsWith(prefix)) return 'same';
    }
    return 'different';
  }

  // A name on one side and only an address on the other proves nothing.
  return 'different';
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
    // The contact block is ONE PERSON, so it is decided as a unit.
    //
    // Filling these five independently is how a record ends up naming somebody
    // it cannot reach beside an address belonging to somebody else. Observed on
    // the Northshore record: `contact_name` held "Dan Sc***n" from an earlier
    // run, `contact_email` was empty, so a later run attached
    // eric.welte@clevelandcliffs.com to Dan's name. Every field was individually
    // correct and the row as a whole named the wrong human — and a seller has no
    // way to tell, because a name and an address is exactly what a good record
    // looks like.
    switch (identifyPerson(current, topContact)) {
      case 'empty':
        // Nobody there yet; the whole person lands.
        fillEmpty('contact_name', topContact.name, origin);
        fillEmpty('contact_title', topContact.title, origin);
        fillEmpty('contact_email', topContact.email, origin);
        fillEmpty('contact_phone', topContact.phone, origin);
        // Both providers return this and it was being dropped. It is on the LDR
        // checklist for a reason: it is how a BDR confirms the person is still in
        // the role we think they are before spending a call.
        fillEmpty('contact_linkedin_url', topContact.linkedin_url, origin);
        break;

      case 'same':
        // The same person, better known. Gaps fill as before, and an obfuscated
        // stored name is REPLACED rather than kept — "Dan Sc***n" is not a name
        // anyone can use, and this is the one case where overwriting is a strict
        // improvement because it is provably the same human.
        if (isObfuscated(current.contact_name) && present(topContact.name) && !isObfuscated(topContact.name)) {
          updates.contact_name = topContact.name;
          provenance.contact_name = origin;
          fieldsAdded.push({ field: 'contact_name', origin, value: topContact.name });
        } else {
          fillEmpty('contact_name', topContact.name, origin);
        }
        fillEmpty('contact_title', topContact.title, origin);
        fillEmpty('contact_email', topContact.email, origin);
        fillEmpty('contact_phone', topContact.phone, origin);
        fillEmpty('contact_linkedin_url', topContact.linkedin_url, origin);
        break;

      case 'different':
        // Somebody else is already the primary contact. Leave the block
        // untouched — the new person is not lost, they are in
        // `additional_contacts` with their own name and address kept together.
        break;
    }
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
