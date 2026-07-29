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
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  email?: string | null;
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
  else if (companyName) body.q_organization_name = companyName;

  try {
    const res = await fetch(`${BASE}/mixed_people/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { people?: ApolloPerson[]; contacts?: ApolloPerson[] };
    const people = data.people ?? data.contacts ?? [];

    return people
      .slice(0, limit)
      .map((p) => {
        const name = p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') || null;
        const email = isRealEmail(p.email) ? p.email! : null;
        return {
          name,
          title: p.title ?? null,
          email,
          phone: personPhone(p) ?? fallbackPhone ?? null,
          linkedin_url: p.linkedin_url ?? null,
          source: 'apollo',
        };
      })
      .filter((c) => c.name || c.title);
  } catch {
    return [];
  }
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
export async function apolloFindOrganization(
  companyName: string | null | undefined,
  location?: string | null
): Promise<ApolloOrganization | null> {
  const apiKey = await readSecret('apollo_api_key');
  if (!apiKey || !companyName?.trim()) return null;

  const query = companyName.trim();

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
