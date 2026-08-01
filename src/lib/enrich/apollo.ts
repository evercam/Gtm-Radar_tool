import 'server-only';
import type { EnrichedContact } from './types';
import { readSecret } from '@/lib/crypto/store';

/**
 * Apollo enrichment engine. Given the account (domain and/or company name)
 * that Claude identified, Apollo returns verified decision-maker contacts
 * (name, title, email, phone, LinkedIn). Free/lower tiers may return masked
 * emails (e.g. "email_not_unlocked@domain.com") — we surface whatever the
 * plan exposes and never fabricate.
 *
 * Requires APOLLO_API_KEY. Base: https://api.apollo.io/api/v1
 */

const BASE = process.env.APOLLO_BASE_URL || 'https://api.apollo.io/api/v1';

/** Decision-maker seniorities, most senior first. Used when the policy names none. */
const SENIORITIES = ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager'];

interface ApolloPerson {
  /** What `people/match` matches on to reveal the address. */
  id?: string | null;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  /** What api_search returns instead of `last_name` — "Ki***a". */
  last_name_obfuscated?: string | null;
  title?: string | null;
  email?: string | null;
  /**
   * api_search reports WHETHER an address exists rather than returning it;
   * revealing one is a separate, credited call. So a contact can arrive
   * knowing an email is available without carrying it.
   */
  has_email?: boolean | null;
  linkedin_url?: string | null;
  phone_numbers?: Array<{ sanitized_number?: string | null; raw_number?: string | null }>;
  organization?: { phone?: string | null } | null;
}

export async function isApolloConfigured(): Promise<boolean> {
  return Boolean(await readSecret('apollo_api_key'));
}

function isRealEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return !/not_unlocked|email_not|domain\.com$/i.test(email) && email.includes('@');
}

/**
 * A company name Apollo will accept as a search term.
 *
 * Apollo answers 422 "invalid character: [" for a bracketed name, and sources
 * annotate freely — GEM writes "Duke Energy Carolinas LLC [100%]" and lists
 * co-owners with semicolons. Cleaned at the source too, but repeated here
 * because this is the last point before the request and a 422 here costs a whole
 * account's contacts.
 */
function searchableName(name: string | null | undefined): string | null {
  if (!name) return null;
  const clean = name
    .split(';')[0]
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || null;
}

function personPhone(p: ApolloPerson): string | null {
  const n = p.phone_numbers?.find((x) => x.sanitized_number || x.raw_number);
  return n?.sanitized_number || n?.raw_number || p.organization?.phone || null;
}

/**
 * Find decision-maker contacts at the account. Prefers a domain filter;
 * falls back to the organization name. Returns [] on any failure (never throws).
 */
export async function apolloFindContacts(params: {
  domain?: string | null;
  companyName?: string | null;
  limit?: number;
  /** Source-personalized target job titles (from the enrichment profile). */
  titles?: string[];
  /** Seniorities to request. Empty or absent falls back to the built-in list. */
  seniorities?: string[];
  /**
   * Company switchboard, used when a person carries no number. Apollo's search
   * endpoint does not return direct dials at all — those need the reveal
   * endpoint — so without this every Apollo contact arrives phoneless.
   */
  fallbackPhone?: string | null;
}): Promise<EnrichedContact[]> {
  const apiKey = await readSecret('apollo_api_key');
  if (!apiKey) return [];
  const { domain, companyName, limit = 5, titles, seniorities, fallbackPhone } = params;
  if (!domain && !companyName) return [];

  const body: Record<string, unknown> = {
    page: 1,
    per_page: Math.min(limit, 10),
    person_seniorities: seniorities?.length ? seniorities : SENIORITIES,
  };
  // Narrow to the roles that matter for this source's account type.
  if (titles?.length) body.person_titles = titles;
  if (domain) body.q_organization_domains_list = [domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')];
  else if (searchableName(companyName)) body.q_organization_name = searchableName(companyName);

  try {
    // `mixed_people/search` is retired for API callers — it answers 422 with
    // "This endpoint is deprecated for API callers", which the `!res.ok` below
    // turned into an empty contact list. Every enrichment run therefore reported
    // success having found nothing, for as long as Apollo has been deprecating
    // it. See https://docs.apollo.io/reference/people-api-search.
    const res = await fetch(`${BASE}/mixed_people/api_search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      // Loudly, because the silent version cost weeks: a contact search that
      // cannot run is not the same answer as an account with nobody in it, and
      // returning [] for both makes the difference invisible.
      const detail = await res.text().catch(() => '');
      console.error(`Apollo people search failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
      return [];
    }
    const data = (await res.json()) as { people?: ApolloPerson[]; contacts?: ApolloPerson[] };
    const people = data.people ?? data.contacts ?? [];

    return people
      .slice(0, limit)
      .map((p) => {
        // api_search obfuscates the surname (`last_name_obfuscated`) where the
        // old endpoint returned it plain, so a contact would otherwise arrive
        // with a first name and nothing else.
        const surname = p.last_name ?? p.last_name_obfuscated ?? null;
        const name = p.name || [p.first_name, surname].filter(Boolean).join(' ') || null;
        const email = isRealEmail(p.email) ? p.email! : null;
        return {
          name,
          title: p.title ?? null,
          email,
          phone: personPhone(p) ?? fallbackPhone ?? null,
          linkedin_url: p.linkedin_url ?? null,
          source: 'apollo',
          apolloPersonId: p.id ?? null,
          hasEmail: p.has_email === true,
        };
      })
      .filter((c) => c.name || c.title);
  } catch {
    return [];
  }
}

/**
 * Turns searched contacts into contactable ones.
 *
 * `api_search` deliberately withholds the address and the surname — it reports
 * `has_email: true` and returns "Ki***a". `people/match` reveals both, matching
 * on the person id the search returned. Proven against a live account: id +
 * domain returned "Shelee Kimura / shelee.kimura@hawaiianelectric.com".
 *
 * This is the step that made the difference between "contacts found" and a lead
 * anyone can act on — without it every contact reached export with a null email
 * and was skipped.
 *
 * Each reveal costs one Apollo credit, so the spending rules are explicit:
 *   - `limit` caps reveals per call, from the enrichment policy.
 *   - A contact that already has a real email is never re-revealed.
 *   - A contact Apollo says has no email is skipped — paying to be told "none"
 *     is the easiest way to burn a plan.
 *   - No person id means nothing to match on; skipped rather than guessed at.
 *
 * Never throws. A contact that cannot be revealed is returned unchanged, so a
 * failed reveal costs the address, not the contact.
 */
export async function apolloRevealContacts(
  contacts: EnrichedContact[],
  params: { domain?: string | null; companyName?: string | null; limit?: number }
): Promise<{ contacts: EnrichedContact[]; revealed: number; attempted: number }> {
  const apiKey = await readSecret('apollo_api_key');
  const { domain, companyName, limit = 0 } = params;
  if (!apiKey || limit <= 0) return { contacts, revealed: 0, attempted: 0 };

  const out = [...contacts];
  let revealed = 0;
  let attempted = 0;

  for (let i = 0; i < out.length && attempted < limit; i++) {
    const c = out[i];
    if (isRealEmail(c.email)) continue;
    if (c.hasEmail === false) continue;
    if (!c.apolloPersonId) continue;

    attempted += 1;
    try {
      const res = await fetch(`${BASE}/people/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          id: c.apolloPersonId,
          ...(domain ? { domain: domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '') } : {}),
          ...(searchableName(companyName) ? { organization_name: searchableName(companyName) } : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error(`Apollo reveal failed: HTTP ${res.status} ${detail.slice(0, 160)}`);
        continue;
      }

      const { person } = (await res.json()) as { person?: ApolloPerson | null };
      if (!person) continue;

      const email = isRealEmail(person.email) ? person.email! : null;
      // The match also returns the unobfuscated name, which is worth keeping
      // even when no address comes back — "Shelee Ki***a" is not a name you can
      // put in front of a seller.
      const fullName =
        person.name || [person.first_name, person.last_name].filter(Boolean).join(' ') || c.name;

      out[i] = {
        ...c,
        name: fullName ?? c.name,
        email: email ?? c.email,
        phone: personPhone(person) ?? c.phone,
        linkedin_url: person.linkedin_url ?? c.linkedin_url,
        hasEmail: Boolean(email) || c.hasEmail,
      };
      if (email) revealed += 1;
    } catch (err) {
      console.error(`Apollo reveal threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { contacts: out, revealed, attempted };
}

/** An organization as Apollo knows it — the account behind a record. */
export interface ApolloOrganization {
  name: string | null;
  domain: string | null;
  website: string | null;
  industry: string | null;
  employeeCount: number | null;
  linkedinUrl: string | null;
  location: string | null;
  /**
   * The company switchboard. Apollo returns this on organization search at no
   * extra credit cost — unlike a direct dial, which needs the reveal endpoint.
   * A main number that reaches the procurement desk beats no number at all.
   */
  phone: string | null;
}

interface ApolloOrgRaw {
  name?: string | null;
  primary_domain?: string | null;
  website_url?: string | null;
  industry?: string | null;
  estimated_num_employees?: number | null;
  linkedin_url?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  phone?: string | null;
  sanitized_phone?: string | null;
  primary_phone?: { number?: string | null; sanitized_number?: string | null } | null;
}

/** Apollo spells the company number three different ways depending on endpoint. */
function orgPhone(o: ApolloOrgRaw): string | null {
  return (
    o.primary_phone?.sanitized_number ||
    o.primary_phone?.number ||
    o.sanitized_phone ||
    o.phone ||
    null
  );
}

/**
 * Resolves a company name to an Apollo organization.
 *
 * This is what makes Apollo genuinely standalone. Contact search needs a
 * domain, and Claude is what normally supplies it — so with Claude disabled
 * this fills the gap by searching Apollo's own company index.
 *
 * Returns the single best match, or null. `location` is used to disambiguate
 * common names, not to filter: a location mismatch is a weaker signal than a
 * name match, so it only breaks ties.
 */
/**
 * The name, then progressively shorter forms of it.
 *
 * Apollo indexes trade names, not registered ones, and matches the term fairly
 * literally — measured against a live account:
 *
 *   "NextEra Energy Inc"       not found     "NextEra Energy"     nexteraenergy.com
 *   "Florida Power & Light Co" not found     "Florida Power & Light"  fpl.com
 *   "Cypress Creek Renewables" not found     "Cypress Creek"      cypresscreekenergy.com
 *
 * Sources hand us the registered entity, so searching it verbatim missed most
 * owners — including major utilities, which is what made the miss look like poor
 * Apollo coverage rather than a query problem. Ordered longest first so the most
 * specific match still wins, and organization search costs nothing when it finds
 * nothing, so the extra attempts are free.
 */
function nameVariants(name: string): string[] {
  const base = searchableName(name);
  if (!base) return [];

  const out = [base];
  const noSuffix = base
    .replace(
      /(incorporated|inc|llc|l\.l\.c|ltd|limited|corporation|corp|company|co|plc|holdings|group|sa|s\.a|spa|gmbh|ag|bv|pty|lp|llp|ab|as|oy|nv)\.?/gi,
      ' '
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (noSuffix && noSuffix !== base) out.push(noSuffix);

  // Then drop the trailing descriptor — "Cypress Creek Renewables" -> "Cypress
  // Creek". Only worth it while at least two words remain, or the query becomes
  // so broad that the match means nothing.
  const words = (noSuffix || base).split(' ');
  if (words.length >= 3) out.push(words.slice(0, -1).join(' '));

  return [...new Set(out)].filter((v) => v.length >= 3);
}

export async function apolloFindOrganization(
  companyName: string | null | undefined,
  location?: string | null
): Promise<ApolloOrganization | null> {
  const apiKey = await readSecret('apollo_api_key');
  if (!apiKey || !companyName?.trim()) return null;

  // Longest form first, then shorter ones, stopping at the first that yields a
  // domain — a domain is the whole point, since contact search needs one.
  let fallback: ApolloOrganization | null = null;
  for (const query of nameVariants(companyName)) {
    const hit = await searchOrganization(apiKey, query, location);
    if (hit?.domain) return hit;
    fallback = fallback ?? hit;
  }
  return fallback;
}

/** One organization search, for one spelling of the name. */
async function searchOrganization(
  apiKey: string,
  query: string,
  location?: string | null
): Promise<ApolloOrganization | null> {
  try {
    const res = await fetch(`${BASE}/mixed_companies/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ q_organization_name: query, page: 1, per_page: 5 }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { organizations?: ApolloOrgRaw[]; accounts?: ApolloOrgRaw[] };
    const orgs = data.organizations ?? data.accounts ?? [];
    if (orgs.length === 0) return null;

    const wanted = query.toLowerCase();
    const loc = location?.toLowerCase() ?? '';

    // Prefer an exact name match, then one whose location agrees, then the
    // first result Apollo ranked.
    const scored = orgs.map((o) => {
      const name = (o.name ?? '').toLowerCase();
      const where = [o.city, o.state, o.country].filter(Boolean).join(' ').toLowerCase();
      let score = 0;
      if (name === wanted) score += 10;
      else if (name.startsWith(wanted) || wanted.startsWith(name)) score += 5;
      else if (name.includes(wanted) || wanted.includes(name)) score += 2;
      if (loc && where && (where.includes(loc) || loc.includes(where))) score += 3;
      if (o.primary_domain) score += 1; // a domain is what we came for
      return { org: o, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    // A result sharing no part of the name is a different company, not a match.
    if (!best || best.score < 2) return null;

    const o = best.org;
    return {
      name: o.name ?? null,
      domain: o.primary_domain ?? null,
      website: o.website_url ?? null,
      industry: o.industry ?? null,
      employeeCount: o.estimated_num_employees ?? null,
      linkedinUrl: o.linkedin_url ?? null,
      location: [o.city, o.state, o.country].filter(Boolean).join(', ') || null,
      phone: orgPhone(o),
    };
  } catch {
    return null;
  }
}
