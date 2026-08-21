import { companyKey } from '@/lib/enrich/contactMatch';

/**
 * Does the company on this lead already exist in the CRM, and as what?
 *
 * Zoho carries a hand-maintained `Account_Type` on every account, and two of its
 * values are worth more than anything the radar computes:
 *
 *   `Forget it / Junk / Avoid` is a do-not-call list somebody curated by hand.
 *   `Lapsed` is a former customer — a warm re-entry, not a cold call.
 *
 * Neither exists anywhere in this pipeline today, so a rep can spend a slot on a
 * company the business already decided to stop chasing.
 *
 * WHY THIS REFUSES SO OFTEN
 *
 * The CRM holds ~25,000 accounts accumulated over a decade, and name collisions
 * are the norm rather than the exception. Measured on real data, not imagined:
 *
 *   `Turner Construction`, `Turner & Townsend` (thirteen regional variants),
 *   `Turner Industries Group`, `Turner Publishing`, `Mark Turner Construction`,
 *   `Thompson Turner Construction` — six different companies, one word.
 *
 *   `BL Harbert International` and `BL Harbert International LLC` are the same
 *   company entered twice, and they can carry different types.
 *
 *   Our UK `ENVIRONMENT AGENCY` matched `National Environment Agency (NEA)
 *   Singapore` on a substring search. Different continent, different organisation.
 *
 * A wrong flag here is worse than no flag: telling a rep a live prospect is
 * `Avoid` costs a real lead, and it costs it silently. So the ladder below returns
 * `ambiguous` rather than picking a winner whenever the evidence does not single
 * one out, and callers must treat `ambiguous` exactly like `no_match`.
 *
 * ONLY A FIFTH OF ACCOUNTS CARRY A DOMAIN
 *
 * Which is why this cannot simply match on domain and stop. Measured across a
 * 200-account sample: roughly 20% have a website, and the bulk-imported US
 * contractor block — Fluor, Bechtel, Mastec, Suffolk, Swinerton, Turner — has
 * none at all, despite being the names most likely to appear in our US book. So
 * name matching carries most of the load and the refusal rules carry the safety.
 */

/** The CRM's own verdict on a company. Values are Zoho's, spelled as Zoho spells them. */
export type CrmAccountType =
  | 'Active'
  | 'Lapsed'
  | 'Forget it / Junk / Avoid'
  | 'Qualified'
  | 'To Be Qualified'
  | 'Customer - To Be Qualified'
  | 'Installation Partner'
  | 'Friend ( Relevant, but not a direct buyer)'
  | 'VC / Evercam Investor'
  | 'Other';

export interface CrmAccount {
  id: string;
  name: string;
  /** Zoho's Website field, in every shape a human ever typed it. */
  website?: string | null;
  accountType?: string | null;
}

export type CrmMatchStatus = 'matched' | 'ambiguous' | 'no_match';

export interface CrmMatch {
  status: CrmMatchStatus;
  account: CrmAccount | null;
  /**
   * `domain` — both sides carried the same registrable host. The only evidence
   *   strong enough to beat a name collision.
   * `exact_name` — normalised names are identical and only one account has it.
   * `none` — nothing matched, or too much did.
   */
  basis: 'domain' | 'exact_name' | 'none';
  confidence: 'high' | 'medium' | 'low';
  /** Why, in words, including why a match was refused. Shown to whoever doubts it. */
  reason: string;
  /** Populated on `ambiguous` so a human can resolve what the code would not. */
  candidates: CrmAccount[];
}

/* -------------------------------------------------------------------------- */
/* Domains                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Public suffixes we must not treat as the registrable domain.
 *
 * `bandk.co.uk` and `pjhegarty.ie` both have to reduce to something that
 * identifies the COMPANY. Taking the last two labels gives `co.uk` for the first,
 * which would then match every British company in the CRM at once — a single
 * collision class big enough to poison the whole feature.
 */
const MULTIPART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'net.uk', 'plc.uk', 'ltd.uk', 'me.uk',
  'com.au', 'net.au', 'org.au', 'gov.au', 'edu.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'com.sg', 'com.my', 'com.br', 'co.za', 'co.in', 'co.jp', 'co.kr', 'com.mx',
]);

/** Free mailbox hosts. A personal address is not a company identity. */
const NOT_COMPANY_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'live.com', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'msn.com',
]);

/**
 * A website field reduced to the domain that identifies the company.
 *
 * Zoho's Website is free text and holds every shape a person can type: bare hosts
 * (`savills.ie`), full URLs with deep paths, a Microsoft entry that is an Outlook
 * deeplink with query parameters, and at least one that is an email address
 * (`kayble@me.com`). All of those are in the live data; none may throw.
 */
export function crmDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  let s = website.trim().toLowerCase();
  if (!s) return null;

  // An email address in the website field. Take the host, then let the free-mail
  // check below discard it if it identifies a person rather than a company.
  if (s.includes('@') && !s.includes('/')) s = s.split('@').pop() ?? '';

  s = s
    .replace(/^[a-z]+:\/\//, '')
    // "www.http://virtuspm.ie" is real, and in the Active list.
    .replace(/^www\./, '')
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0].trim();
  if (!s || !s.includes('.') || /\s/.test(s)) return null;

  const labels = s.split('.').filter(Boolean);
  if (labels.length < 2) return null;

  const lastTwo = labels.slice(-2).join('.');
  const registrable = MULTIPART_SUFFIXES.has(lastTwo)
    ? labels.slice(-3).join('.')
    : lastTwo;

  // A bare public suffix is not a company.
  if (MULTIPART_SUFFIXES.has(registrable) || !registrable.includes('.')) return null;
  if (NOT_COMPANY_DOMAINS.has(registrable)) return null;
  return registrable;
}

/* -------------------------------------------------------------------------- */
/* Accounts that must never match anything                                     */
/* -------------------------------------------------------------------------- */

/**
 * Junk in the Accounts module, which arrives there through web forms.
 *
 * The live `Forget it / Junk / Avoid` list contains `Leon Blaq`, `Andy Zhang`,
 * `Sven Hemmingsson`, `Timothy Carswell` and others that are plainly people, not
 * companies. Letting a two-word personal name into the matcher is how a real
 * construction firm called `Thomas Young Builders` gets flagged do-not-call.
 *
 * Deliberately conservative: it only rejects a bare two-word name with no
 * corporate word anywhere in it, so `Thomas O'Brien Construction` and
 * `John Curran & Sons` — both real firms in that same list — survive.
 */
const CORPORATE_WORDS =
  /\b(construction|constructions|build|builders|building|contract|contractors|contracting|engineering|engineers|group|holdings?|partners|associates|services|solutions|systems|developments?|properties|property|homes|civil|electrical|mechanical|plant|energy|power|industries|international|consulting|consultants|architects|council|university|authority|trust|agency|company|corporation|technologies|technology|logistics|capital|ventures|and|sons|bros|brothers|ltd|limited|llc|inc|plc|gmbh|pty|bv|nv|ag)\b/i;

export function looksLikePerson(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  if (CORPORATE_WORDS.test(n)) return false;
  if (/[0-9&.,/]/.test(n)) return false;
  const words = n.split(/\s+/);
  return words.length === 2 && words.every((w) => /^[A-Z][a-z']{1,15}$/.test(w));
}

/**
 * Whether an account is eligible to be matched at all.
 *
 * An account with no type carries no verdict, so matching it tells a rep nothing
 * while still risking a wrong association. Excluded rather than surfaced blank.
 */
export function isMatchable(a: CrmAccount): boolean {
  if (!a.name?.trim()) return false;
  if (!a.accountType?.trim()) return false;
  return !looksLikePerson(a.name);
}

/* -------------------------------------------------------------------------- */
/* The index                                                                   */
/* -------------------------------------------------------------------------- */

export interface CrmIndex {
  byDomain: Map<string, CrmAccount[]>;
  byName: Map<string, CrmAccount[]>;
  size: number;
  /** Excluded as junk or untyped. Reported rather than silently dropped. */
  skipped: number;
}

/**
 * Built once and reused for every record.
 *
 * Both maps hold ARRAYS, never a single account, because collisions are the
 * thing this module exists to survive. A Map<string, CrmAccount> would silently
 * keep whichever account happened to be inserted last — which is exactly how one
 * of six Turners would end up being the answer.
 */
export function buildCrmIndex(accounts: CrmAccount[]): CrmIndex {
  const byDomain = new Map<string, CrmAccount[]>();
  const byName = new Map<string, CrmAccount[]>();
  let size = 0;
  let skipped = 0;

  for (const a of accounts) {
    if (!isMatchable(a)) {
      skipped++;
      continue;
    }
    size++;
    const d = crmDomain(a.website);
    if (d) {
      const list = byDomain.get(d) ?? [];
      list.push(a);
      byDomain.set(d, list);
    }
    const k = companyKey(a.name);
    if (k) {
      const list = byName.get(k) ?? [];
      list.push(a);
      byName.set(k, list);
    }
  }
  return { byDomain, byName, size, skipped };
}

/* -------------------------------------------------------------------------- */
/* The match                                                                   */
/* -------------------------------------------------------------------------- */

const NO_MATCH: CrmMatch = {
  status: 'no_match',
  account: null,
  basis: 'none',
  confidence: 'low',
  reason: 'no CRM account with this name or domain',
  candidates: [],
};

/**
 * Several accounts can be the same company entered twice — `BL Harbert
 * International` and `BL Harbert International LLC`. That is only safe to collapse
 * when they agree on the verdict, because the verdict is the entire payload: two
 * rows both saying `Active` are one answer, while one `Active` and one `Lapsed`
 * is a question no code should answer on a rep's behalf.
 */
function agreeOnType(candidates: CrmAccount[]): boolean {
  const types = new Set(candidates.map((c) => (c.accountType ?? '').trim()));
  return types.size === 1;
}

export function matchCrmAccount(
  lead: { companyName?: string | null; domain?: string | null; website?: string | null },
  index: CrmIndex
): CrmMatch {
  // Domain first. It is the only evidence that survives a name collision, and it
  // is why the Turner family is resolvable at all: tcco.com is one company.
  const leadDomain = crmDomain(lead.domain) ?? crmDomain(lead.website);
  if (leadDomain) {
    const hits = index.byDomain.get(leadDomain) ?? [];
    if (hits.length === 1) {
      return {
        status: 'matched',
        account: hits[0],
        basis: 'domain',
        confidence: 'high',
        reason: `same domain (${leadDomain})`,
        candidates: hits,
      };
    }
    if (hits.length > 1 && agreeOnType(hits)) {
      return {
        status: 'matched',
        account: hits[0],
        basis: 'domain',
        confidence: 'medium',
        reason: `${hits.length} CRM accounts share ${leadDomain} and agree they are ${hits[0].accountType}`,
        candidates: hits,
      };
    }
    if (hits.length > 1) {
      return {
        status: 'ambiguous',
        account: null,
        basis: 'none',
        confidence: 'low',
        reason: `${hits.length} CRM accounts share ${leadDomain} and disagree on type`,
        candidates: hits,
      };
    }
  }

  const key = companyKey(lead.companyName);
  if (!key) return NO_MATCH;

  const named = index.byName.get(key) ?? [];
  if (named.length === 0) return NO_MATCH;

  if (named.length === 1) {
    return {
      status: 'matched',
      account: named[0],
      basis: 'exact_name',
      // Never `high` without a domain. An exact normalised-name match is strong
      // evidence and still only a name, and the cost of being wrong is a real
      // lead marked do-not-call.
      confidence: 'medium',
      reason: `exact name match on "${named[0].name}"`,
      candidates: named,
    };
  }

  if (agreeOnType(named)) {
    return {
      status: 'matched',
      account: named[0],
      basis: 'exact_name',
      confidence: 'low',
      reason: `${named.length} CRM accounts share this name and agree they are ${named[0].accountType}`,
      candidates: named,
    };
  }

  return {
    status: 'ambiguous',
    account: null,
    basis: 'none',
    confidence: 'low',
    reason: `${named.length} CRM accounts share this name and disagree on type`,
    candidates: named,
  };
}

/* -------------------------------------------------------------------------- */
/* What a match means to a seller                                              */
/* -------------------------------------------------------------------------- */

export type CrmSignal = 'avoid' | 'customer' | 'lapsed' | 'partner' | 'known' | 'none';

/**
 * The account type reduced to what a rep should DO about it.
 *
 * Only `avoid`, `customer` and `lapsed` change a conversation. The rest collapse
 * to `known`, which says the company exists in the CRM and nothing more — worth
 * showing so "not in the CRM" stays distinguishable from "in it, uninterestingly".
 */
export function crmSignal(accountType: string | null | undefined): CrmSignal {
  const t = (accountType ?? '').trim().toLowerCase();
  if (!t) return 'none';
  if (t.includes('forget') || t.includes('junk') || t.includes('avoid')) return 'avoid';
  if (t === 'active') return 'customer';
  if (t === 'lapsed') return 'lapsed';
  if (t.includes('partner') || t.includes('investor')) return 'partner';
  return 'known';
}
