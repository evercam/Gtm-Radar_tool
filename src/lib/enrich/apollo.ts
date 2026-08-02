import 'server-only';
import type { EnrichedContact } from './types';
import { readSecret } from '@/lib/crypto/store';
import { suggestCompanyAliases } from './companyAliases';

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
export interface RevealOutcome {
  contacts: EnrichedContact[];
  revealed: number;
  attempted: number;
  /** Why the rest produced nothing. Counts, one bucket per reason. */
  skipped: {
    noKey: number;
    alreadyHasEmail: number;
    noEmailOnFile: number;
    noPersonId: number;
    /** Apollo answered 200 with `person: null`. */
    notFound: number;
    httpError: number;
  };
}

export async function apolloRevealContacts(
  contacts: EnrichedContact[],
  params: { domain?: string | null; companyName?: string | null; limit?: number }
): Promise<RevealOutcome> {
  const apiKey = await readSecret('apollo_api_key');
  const { domain, companyName, limit = 0 } = params;
  // Every reason this can produce nothing, counted. "0 revealed" used to be one
  // number covering four completely different situations — no key, nobody worth
  // trying, Apollo refusing the call, Apollo having no record — and the three
  // skips plus the `!person` branch all `continue`d without a word. Diagnosing a
  // zero meant reproducing the whole run by hand.
  const skipped = { noKey: 0, alreadyHasEmail: 0, noEmailOnFile: 0, noPersonId: 0, notFound: 0, httpError: 0 };
  if (!apiKey || limit <= 0) {
    if (!apiKey) skipped.noKey = contacts.length;
    return { contacts, revealed: 0, attempted: 0, skipped };
  }

  const out = [...contacts];
  let revealed = 0;
  let attempted = 0;

  for (let i = 0; i < out.length && attempted < limit; i++) {
    const c = out[i];
    if (isRealEmail(c.email)) {
      skipped.alreadyHasEmail++;
      continue;
    }
    if (c.hasEmail === false) {
      skipped.noEmailOnFile++;
      continue;
    }
    if (!c.apolloPersonId) {
      skipped.noPersonId++;
      continue;
    }

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
        skipped.httpError++;
        continue;
      }

      const { person } = (await res.json()) as { person?: ApolloPerson | null };
      if (!person) {
        // A 200 with nothing in it. Apollo accepted the call and had no record
        // to return — which is a different problem from a rejected call, and
        // used to look identical to it.
        console.warn(`Apollo reveal: 200 but no person for ${c.name ?? c.apolloPersonId}.`);
        skipped.notFound++;
        continue;
      }

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
      skipped.httpError++;
    }
  }

  return { contacts: out, revealed, attempted, skipped };
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
  /**
   * Which tier resolved it: the published name, a rule-generated spelling, or a
   * Claude-proposed alias. Carried so a surprising account is traceable to the
   * step that produced it rather than looking like Apollo's own answer.
   */
  resolvedVia?: 'name' | 'rules' | 'claude';
  /** The term Apollo actually matched. */
  queriedAs?: string;
  /** Claude's one-line justification, when tier 3 resolved it. */
  aliasReasoning?: string | null;
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
  // The word boundary on BOTH sides is load-bearing, and the two-letter forms are deliberately
  // gone. Unanchored they matched inside ordinary words — "Renewables" lost its
  // `ab` and became "Renew les", "Mesabi" lost its `sa` and became "Me bi". A
  // mangled query matches nothing, so the ladder silently resolved nothing.
  const noSuffix = base
    .replace(
      /\b(incorporated|inc|llc|ltd|limited|corporation|corp|company|co|plc|holdings|group|spa|gmbh|pty|llp)\b\.?/gi,
      ' '
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (noSuffix && noSuffix !== base) out.push(noSuffix);

  // Then drop a trailing GENERIC descriptor — "Cypress Creek Renewables" ->
  // "Cypress Creek". Only a generic word, never a distinctive one, because
  // shortening past the distinctive part matches a different company entirely:
  // "United States Steel" -> "United States" returns war.gov, and "Empire Iron
  // Mining" -> "Empire Iron" returns a fence company. The `score < 2` guard below
  // cannot catch those — the wrong org genuinely contains the query as a
  // substring — and a confidently wrong domain is worse than no domain, because
  // it puts contacts at an unrelated organisation in front of a seller.
  const words = (noSuffix || base).split(' ');
  const GENERIC = new Set([
    'renewables', 'renewable', 'energy', 'energies', 'mining', 'mines', 'resources',
    'solar', 'wind', 'power', 'utilities', 'services', 'service', 'partners',
    'ventures', 'development', 'developments', 'projects', 'international',
    'industries', 'enterprises', 'systems', 'technologies', 'management',
  ]);
  if (words.length >= 3 && GENERIC.has(words[words.length - 1].toLowerCase())) {
    out.push(words.slice(0, -1).join(' '));
  }

  return [...new Set(out)].filter((v) => v.length >= 3);
}

export interface FindOrganizationOptions {
  /**
   * Let Claude propose alternative names when the string rules find no domain.
   * Off by default, and gated by the enrichment policy's Claude toggle — this
   * tier costs a model call per unresolved account.
   */
  useClaudeAliases?: boolean;
  /** Extra context for the alias prompt; ignored when the tier is off. */
  vertical?: string | null;
}

/**
 * Resolve a company to an Apollo organization, in three tiers.
 *
 *   1. the name exactly as the source published it
 *   2. rule-generated spellings — legal suffix dropped, trailing generic
 *      descriptor dropped (see `nameVariants`)
 *   3. names Claude proposes, when tiers 1–2 found no domain
 *
 * Tier 3 exists because tiers 1–2 are string edits, and the dominant failure is
 * not spelling: sources publish the asset-owning entity ("Hibbing Taconite",
 * "Cleveland-Cliffs Minorca Mine") while Apollo indexes the operating parent.
 * No substring of the former is the latter. Of the 15 mining owners in the last
 * export, 12 failed exactly this way and only 3 contacts reached the seller.
 *
 * Every tier ends at the same place — `searchOrganization`, with its `score < 2`
 * guard. Claude only ever supplies a QUERY. Nothing it says about a company is
 * believed unless Apollo independently holds a matching organisation, so a
 * confidently wrong alias resolves to nothing rather than to the wrong company.
 */
export async function apolloFindOrganization(
  companyName: string | null | undefined,
  location?: string | null,
  options: FindOrganizationOptions = {}
): Promise<ApolloOrganization | null> {
  const apiKey = await readSecret('apollo_api_key');
  if (!apiKey || !companyName?.trim()) return null;

  // Longest form first, then shorter ones, stopping at the first that yields a
  // domain — a domain is the whole point, since contact search needs one.
  const tried = new Set<string>();
  let fallback: ApolloOrganization | null = null;
  for (const query of nameVariants(companyName)) {
    tried.add(query.toLowerCase());
    const hit = await searchOrganization(apiKey, query, location);
    if (hit?.domain) return { ...hit, resolvedVia: tried.size === 1 ? 'name' : 'rules', queriedAs: query };
    fallback = fallback ?? hit;
  }

  if (!options.useClaudeAliases) return fallback;

  const { names, domainHint, reasoning } = await suggestCompanyAliases(companyName, {
    location,
    vertical: options.vertical,
  });
  if (names.length === 0 && !domainHint) return fallback;

  for (const alias of names) {
    if (tried.has(alias.toLowerCase())) continue;
    tried.add(alias.toLowerCase());
    const hit = await searchOrganization(apiKey, alias, location);
    if (hit?.domain) return { ...hit, resolvedVia: 'claude', queriedAs: alias, aliasReasoning: reasoning };
    fallback = fallback ?? hit;
  }

  // The domain last, and still as a lookup rather than an answer: it is used to
  // find Apollo's record for that company, and is dropped if Apollo has none.
  if (domainHint) {
    const hit = await searchOrganizationByDomain(apiKey, domainHint);
    if (hit?.domain) return { ...hit, resolvedVia: 'claude', queriedAs: domainHint, aliasReasoning: reasoning };
  }

  return fallback;
}

/**
 * Look a company up by domain.
 *
 * Only ever called with a domain Claude proposed, and deliberately strict: the
 * organisation Apollo returns must actually carry that domain. A near-miss here
 * would attach a seller to a company nobody asked about.
 */
async function searchOrganizationByDomain(apiKey: string, domain: string): Promise<ApolloOrganization | null> {
  try {
    const res = await fetch(`${BASE}/mixed_companies/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ q_organization_domains_list: [domain], page: 1, per_page: 5 }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { organizations?: ApolloOrgRaw[]; accounts?: ApolloOrgRaw[] };
    const orgs = data.organizations ?? data.accounts ?? [];
    const o = orgs.find((x) => (x.primary_domain ?? '').toLowerCase() === domain.toLowerCase());
    if (!o) return null;

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
