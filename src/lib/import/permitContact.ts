/**
 * The person named on a building permit.
 *
 * Permit feeds carry the applicant's own name — split across first/last fields —
 * and this pipeline has been throwing it away and then paying Apollo to guess a
 * contact by job title at the company instead. Measured on 400 NYC/Chicago
 * permits: 96% carry a usable named person, we stored one on 29%, so 70% had a
 * name we discarded.
 *
 * That name is worth more than anything a persona search returns, for one reason:
 * it is attached to THIS project, at THIS address, on the date of THIS filing.
 * A title-matched contact is an inference about a company; a permit applicant is a
 * documented fact about a job. It is also inherently fresh — a permit filed last
 * month names somebody who held that role last month, which is the failure mode
 * behind the measured 30% stale rate on called contacts.
 *
 * Pure — no I/O — so the field-name variations are testable, and the same rules
 * apply whether this runs at ingest or over the existing book.
 */

/**
 * Field pairs, strongest witness first.
 *
 * The PERMITTEE is the party that pulled the permit and is doing the work, so they
 * are the better sales contact where present. The OWNER is whoever holds the
 * property — always present, but more often a holding company's officer than
 * somebody managing the build.
 *
 * Names vary by feed (Socrata exposes NYC DOB as `owner_s_first_name`, Chicago
 * uses different spellings), so each candidate is a list rather than one key. An
 * unrecognised feed yields nothing rather than a wrong guess.
 */
const CANDIDATES: { role: PermitContactRole; first: string[]; last: string[]; full: string[] }[] = [
  {
    role: 'permittee',
    first: ['permittee_s_first_name', 'permittee_first_name', 'contractor_first_name'],
    last: ['permittee_s_last_name', 'permittee_last_name', 'contractor_last_name'],
    full: ['permittee_name', 'contact_name'],
  },
  {
    role: 'owner',
    first: ['owner_s_first_name', 'owner_first_name', 'applicant_first_name'],
    last: ['owner_s_last_name', 'owner_last_name', 'applicant_last_name'],
    full: ['owner_name', 'applicant_name'],
  },
];

export type PermitContactRole = 'permittee' | 'owner';

export interface PermitContact {
  name: string;
  role: PermitContactRole;
  /** The business the person is named against, where the feed gives one. */
  company: string | null;
  /** Which fields it came from, for field_provenance. */
  fields: string[];
}

const clean = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

/*
  Values that are present but are not a person.

  Permit feeds put the literal string "owner" in the owner-name field when the
  applicant is the property owner acting for themselves, and business suffixes turn
  up in name fields when a company filed rather than an individual. Storing either
  as `contact_name` would produce a lead addressed to "Owner" or "LLC", which is
  worse than an empty field because the export would happily send it.
*/
const NOT_A_PERSON = /^(owner|self|same|n\/?a|none|unknown|tbd|applicant|contractor|llc|inc|corp|ltd)\.?$/i;
const COMPANY_SHAPED = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|ltd|limited|company|co|associates|holdings|partners|trust|lp|llp|group|properties|realty)\b\.?$/i;

/**
 * Title-case a shouted name.
 *
 * These feeds are inconsistent — "MOZAFAR ZAHABIAN" and "Daniel Wiener" both
 * appear in the same table. Left as-is, a rep's email opens by shouting at
 * somebody, so the case is normalised. Particles and initials are preserved:
 * "MCDONALD" becoming "Mcdonald" is wrong but harmless, while "O'BRIEN" becoming
 * "O'brien" is the same class of small wrongness — worth accepting, because the
 * alternative is a full name-casing library for a cosmetic gain.
 */
function titleCase(value: string): string {
  if (!/[a-z]/.test(value)) {
    return value
      .toLowerCase()
      .replace(/(^|[\s\-'])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
  }
  return value;
}

/** Is this a plausible person's name rather than an entity or a placeholder? */
function looksLikePerson(name: string): boolean {
  if (name.length < 4 || NOT_A_PERSON.test(name)) return false;
  if (COMPANY_SHAPED.test(name)) return false;
  // At least two words: a lone surname cannot be addressed and cannot be matched
  // against Apollo with any confidence.
  if (name.split(/\s+/).filter((w) => w.length > 1).length < 2) return false;
  /*
    A street address in the name field. Observed: "521 BROADWAY" as the owner name,
    which passes a digit-ratio test — three digits in twelve characters — while
    being obviously not a person. Nobody's name starts with a number.
  */
  if (/^\d/.test(name)) return false;
  // A value that is mostly digits is a reference number in the wrong column.
  return (name.replace(/\D/g, '').length / name.length) < 0.3;
}

const COMPANY_FIELDS = ['owner_s_business_name', 'owner_business_name', 'permittee_s_business_name', 'business_name'];

/**
 * The best named person on a permit payload, or null.
 *
 * Null rather than a partial: a first name with no surname, or a business acting
 * for itself, is not a contact. Returning something unusable would push the
 * problem downstream to the export, which cannot tell the difference.
 */
export function permitContactFrom(raw: Record<string, unknown> | null | undefined): PermitContact | null {
  if (!raw || typeof raw !== 'object') return null;

  for (const candidate of CANDIDATES) {
    // Split fields first — they are the common shape and unambiguous.
    for (const fk of candidate.first) {
      for (const lk of candidate.last) {
        const first = clean(raw[fk]);
        const last = clean(raw[lk]);
        if (!first || !last) continue;
        const name = titleCase(`${first} ${last}`.replace(/\s+/g, ' '));
        if (!looksLikePerson(name)) continue;
        return { name, role: candidate.role, company: companyFrom(raw), fields: [fk, lk] };
      }
    }
    // Then a single full-name field.
    for (const key of candidate.full) {
      const value = clean(raw[key]);
      if (!value) continue;
      const name = titleCase(value.replace(/\s+/g, ' '));
      if (!looksLikePerson(name)) continue;
      return { name, role: candidate.role, company: companyFrom(raw), fields: [key] };
    }
  }
  return null;
}

function companyFrom(raw: Record<string, unknown>): string | null {
  for (const key of COMPANY_FIELDS) {
    const value = clean(raw[key]);
    if (value && !NOT_A_PERSON.test(value)) return value;
  }
  return null;
}
