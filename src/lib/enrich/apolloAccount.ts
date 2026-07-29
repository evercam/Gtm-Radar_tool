import 'server-only';
import { readSecret } from '@/lib/crypto/store';

/**
 * Which Apollo account a record belongs to.
 *
 * The export used to send a company name and a website and let Apollo decide.
 * That is safe right up until a company has more than one account, and this
 * workspace has NINE "Balfour Beatty" accounts — five of them sharing
 * balfourbeatty.com:
 *
 *   Balfour Beatty                 balfourbeatty.com   United Kingdom
 *   Balfour Beatty (US)            balfourbeatty.com   United Kingdom  ← wrong
 *   Balfour Beatty (Dublin)        balfourbeatty.com   (blank)
 *   Balfour Beatty Major Projects  balfourbeatty.com   (blank)
 *   Balfour Beatty Kilpatrick      balfourbeatty.com   United Kingdom
 *
 * Country does not separate them: the US account is labelled United Kingdom
 * and two carry no country at all. The distinction lives only in the account
 * NAME. So this resolves an id once, records which name it chose, and refuses
 * to guess when the candidates are genuinely ambiguous — a contact on the
 * wrong account is worse than a contact on no account, because it syncs into
 * the wrong CRM record and nobody notices.
 */

const BASE = 'https://api.apollo.io';

export interface ApolloAccountMatch {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  crmRecordUrl: string | null;
  ownerId: string | null;
  parentAccountId: string | null;
}

export type AccountResolution =
  | { status: 'matched'; account: ApolloAccountMatch; confidence: 'exact' | 'strong' }
  | { status: 'ambiguous'; candidates: ApolloAccountMatch[]; reason: string }
  | { status: 'none'; reason: string };

interface RawAccount {
  id?: string;
  name?: string;
  domain?: string | null;
  primary_domain?: string | null;
  country?: string | null;
  organization_country?: string | null;
  crm_record_url?: string | null;
  owner_id?: string | null;
  parent_account_id?: string | null;
}

function toMatch(a: RawAccount): ApolloAccountMatch {
  return {
    id: a.id ?? '',
    name: a.name ?? '',
    domain: a.primary_domain ?? a.domain ?? null,
    country: a.organization_country ?? a.country ?? null,
    crmRecordUrl: a.crm_record_url ?? null,
    ownerId: a.owner_id ?? null,
    parentAccountId: a.parent_account_id ?? null,
  };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|plc|group|holdings|sa|spa|gmbh|ag|bv|pty|the)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Country hints that appear inside account NAMES, since the country field is unreliable. */
const NAME_HINTS: Record<string, RegExp> = {
  'united states': /\((us|usa)\)|\bus\b|\busa\b/i,
  ireland: /\(dublin\)|\bireland\b|\birish\b/i,
  'united kingdom': /\(uk\)|\buk\b|\bbritish\b/i,
  australia: /\(au\)|\baustralia\b/i,
  canada: /\(ca\)|\bcanada\b/i,
};

/**
 * Score a candidate against the record's own country.
 *
 * The account NAME is checked before the country field, deliberately: a name
 * saying "(US)" is a decision someone made, while the country field on that
 * same account says United Kingdom and is simply wrong.
 */
function countryAgreement(candidate: ApolloAccountMatch, country: string | null): 'name' | 'field' | 'none' | 'conflict' {
  if (!country) return 'none';
  const want = country.toLowerCase();

  for (const [c, re] of Object.entries(NAME_HINTS)) {
    if (re.test(candidate.name)) return c === want ? 'name' : 'conflict';
  }
  if (candidate.country && candidate.country.toLowerCase() === want) return 'field';
  return 'none';
}

export async function resolveApolloAccount(params: {
  companyName: string | null | undefined;
  domain?: string | null;
  country?: string | null;
}): Promise<AccountResolution> {
  const apiKey = await readSecret('apollo_api_key');
  if (!apiKey) return { status: 'none', reason: 'No Apollo API key configured.' };

  const name = params.companyName?.trim();
  if (!name) return { status: 'none', reason: 'No company name to resolve.' };

  let raw: RawAccount[] = [];
  try {
    const res = await fetch(`${BASE}/api/v1/accounts/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ q_organization_name: name, page: 1, per_page: 25 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { status: 'none', reason: `Apollo ${res.status}` };
    raw = ((await res.json()) as { accounts?: RawAccount[] }).accounts ?? [];
  } catch (e) {
    return { status: 'none', reason: e instanceof Error ? e.message : String(e) };
  }

  const candidates = raw.map(toMatch).filter((c) => c.id);
  if (candidates.length === 0) return { status: 'none', reason: `No Apollo account matches "${name}".` };
  if (candidates.length === 1) return { status: 'matched', account: candidates[0], confidence: 'exact' };

  const wanted = norm(name);

  /**
   * Does this workspace keep a family of country-specific accounts under this
   * name? "Balfour Beatty" plus "Balfour Beatty (US)" and "(Dublin)" is a
   * family; a bare exact-name match inside one is the GLOBAL entry, not the
   * answer for a particular country.
   *
   * This check has to come before the exact-name shortcut. Without it, asking
   * for the US account returns the UK one with full confidence — the precise
   * mistake that puts contacts on the wrong CRM record.
   */
  const family = candidates.filter((c) => norm(c.name).startsWith(wanted));
  const countryEntries = family.filter((c) => Object.values(NAME_HINTS).some((re) => re.test(c.name)));

  if (params.country && countryEntries.length > 0) {
    const forCountry = family.filter((c) => countryAgreement(c, params.country ?? null) === 'name');
    if (forCountry.length === 1) return { status: 'matched', account: forCountry[0], confidence: 'strong' };
    if (forCountry.length > 1) {
      return {
        status: 'ambiguous',
        candidates: forCountry,
        reason: `${forCountry.length} Apollo accounts name ${params.country} under "${name}".`,
      };
    }
    // The family names other countries but not this one, so the generic entry
    // may or may not be right. Refuse rather than guess.
    return {
      status: 'ambiguous',
      candidates: family.slice(0, 10),
      reason: `"${name}" has country-specific accounts in Apollo but none for ${params.country}. Pick one.`,
    };
  }

  const exact = candidates.filter((c) => norm(c.name) === wanted);

  // A single exact name is the answer only when no country-specific siblings
  // exist to contradict it.
  if (exact.length === 1 && countryEntries.length === 0) {
    return { status: 'matched', account: exact[0], confidence: 'exact' };
  }
  if (exact.length === 1 && countryEntries.length > 0 && !params.country) {
    return {
      status: 'ambiguous',
      candidates: family.slice(0, 10),
      reason: `"${name}" has ${countryEntries.length} country-specific accounts in Apollo and this record has no country to choose by.`,
    };
  }

  const pool = exact.length > 1 ? exact : candidates;
  const agreeing = pool.filter((c) => {
    const a = countryAgreement(c, params.country ?? null);
    return a === 'name' || a === 'field';
  });

  if (agreeing.length === 1) return { status: 'matched', account: agreeing[0], confidence: 'strong' };

  return {
    status: 'ambiguous',
    candidates: pool.slice(0, 10),
    reason:
      agreeing.length > 1
        ? `${agreeing.length} Apollo accounts match "${name}" for ${params.country ?? 'this country'}.`
        : `${pool.length} Apollo accounts are named like "${name}" and none names a country that matches${
            params.country ? ` ${params.country}` : ''
          }.`,
  };
}
