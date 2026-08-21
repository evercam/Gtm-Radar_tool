/**
 * How well does this contact fit this project?
 *
 * Three questions, in the order they matter: does this person still work there,
 * have they just moved, and are they anywhere near the site. Until now a contact
 * was chosen on reachability and title seniority alone (see the sort in
 * enrich/run.ts), so a Project Director who left the company in March outranked a
 * current site manager in the right state.
 *
 * WHY THIS RUNS AFTER THE REVEAL AND NOT BEFORE
 *
 * Apollo's search endpoint cannot answer any of it. `mixed_people/api_search`
 * returns `has_state`, `has_city` and `has_country` as BOOLEANS — never the values
 * — and carries no employment history, departments or seniority at all. The full
 * person only comes back from `people/match`, which is the credited reveal. So
 * geography cannot filter candidates before we pay; it can only judge one already
 * bought. The reveal was already returning all of this and the caller was keeping
 * four fields of it.
 *
 * PURE ON PURPOSE
 *
 * No network, no database, no clock except the one passed in. Everything here is a
 * judgement that has to be explainable to a seller looking at a lead, and the way
 * to keep it explainable is to make it testable.
 */

/** What we know about the project. Every field is optional because most of them are. */
export interface ProjectLocation {
  stateProvince?: string | null;
  country?: string | null;
  countryCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface ContactEmployment {
  organizationName?: string | null;
  organizationId?: string | null;
  title?: string | null;
  /** Apollo marks the present role. */
  current?: boolean | null;
  startDate?: string | null;
  endDate?: string | null;
}

/** The contact, as it reaches us from a reveal. */
export interface ContactFacts {
  title?: string | null;
  state?: string | null;
  city?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  employment?: ContactEmployment[] | null;
  /** Apollo's own note of when it last touched this record. */
  lastRefreshedAt?: string | null;
}

export type GeoMatch = 'same_state' | 'nearby' | 'distant' | 'unknown';
export type EmploymentStatus = 'current' | 'left' | 'unknown';

export interface MatchVerdict {
  geo: GeoMatch;
  /** Kilometres, only when BOTH sides carry coordinates. 16% of reachable leads do. */
  distanceKm: number | null;
  employment: EmploymentStatus;
  /** Every job-change signal found, as reasons rather than one boolean. */
  signals: string[];
  /** 0–100. Ordering key, not a probability — see the comment on scoreMatch. */
  score: number;
  confidence: 'high' | 'medium' | 'low';
  /** Why, in the order the reasons were applied. Shown to the seller. */
  reasons: string[];
}

/* -------------------------------------------------------------------------- */
/* Company identity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Enough normalisation to tell "NRG Energy, Inc." from "Duke Energy", and not a
 * character more.
 *
 * Deliberately not an alias resolver. `companyAliases.ts` exists for that and asks
 * an LLM, which is the right tool for "is Ørsted the same as DONG Energy" and the
 * wrong one for a function that has to be pure and run per contact. When the ids
 * are present they are compared instead and this is never consulted.
 */
const LEGAL_SUFFIXES =
  /\b(inc|incorporated|corp|corporation|co|company|llc|llp|lp|ltd|limited|plc|gmbh|sa|nv|bv|ag|as|group|holdings?|international|intl)\b/g;

export function companyKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,'’"()]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return key || null;
}

/** Same employer? Ids when both sides have them, normalised names otherwise. */
export function sameCompany(
  a: { id?: string | null; name?: string | null },
  b: { id?: string | null; name?: string | null }
): boolean {
  if (a.id && b.id) return a.id === b.id;
  const ka = companyKey(a.name);
  const kb = companyKey(b.name);
  return Boolean(ka && kb && ka === kb);
}

/* -------------------------------------------------------------------------- */
/* Geography                                                                   */
/* -------------------------------------------------------------------------- */

const US_STATE_CODES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

/**
 * "Texas", "texas" and "TX" are one state.
 *
 * Sources spell it however they spell it, and Apollo returns full names while
 * several of our adapters store codes. Without this every US match would be a miss
 * and the whole feature would score `unknown` — the silent no-op this plan was
 * written to avoid.
 */
export function stateCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  return US_STATE_CODES[raw.toLowerCase()] ?? raw.toLowerCase();
}

/**
 * Which states touch which. Only the ones adjacency is meaningful for.
 *
 * A partial map on purpose: "nearby" is a nicety and a missing entry costs one
 * step of ranking, whereas a wrong entry claims a closeness that is not there.
 * Anything absent falls through to `distant`, which is honest.
 */
const ADJACENT: Record<string, string[]> = {
  TX: ['NM', 'OK', 'AR', 'LA'], NM: ['AZ', 'CO', 'OK', 'TX', 'UT'], AZ: ['CA', 'NV', 'UT', 'CO', 'NM'],
  CA: ['OR', 'NV', 'AZ'], NV: ['CA', 'OR', 'ID', 'UT', 'AZ'], OR: ['WA', 'ID', 'NV', 'CA'],
  WA: ['OR', 'ID'], ID: ['WA', 'OR', 'NV', 'UT', 'WY', 'MT'], UT: ['ID', 'WY', 'CO', 'NM', 'AZ', 'NV'],
  CO: ['WY', 'NE', 'KS', 'OK', 'NM', 'UT'], WY: ['MT', 'SD', 'NE', 'CO', 'UT', 'ID'],
  MT: ['ID', 'WY', 'SD', 'ND'], ND: ['MT', 'SD', 'MN'], SD: ['ND', 'MN', 'IA', 'NE', 'WY', 'MT'],
  NE: ['SD', 'IA', 'MO', 'KS', 'CO', 'WY'], KS: ['NE', 'MO', 'OK', 'CO'], OK: ['KS', 'MO', 'AR', 'TX', 'NM', 'CO'],
  MN: ['ND', 'SD', 'IA', 'WI'], IA: ['MN', 'WI', 'IL', 'MO', 'NE', 'SD'], MO: ['IA', 'IL', 'KY', 'TN', 'AR', 'OK', 'KS', 'NE'],
  AR: ['MO', 'TN', 'MS', 'LA', 'TX', 'OK'], LA: ['TX', 'AR', 'MS'], WI: ['MN', 'IA', 'IL', 'MI'],
  IL: ['WI', 'IA', 'MO', 'KY', 'IN'], MI: ['WI', 'IN', 'OH'], IN: ['MI', 'OH', 'KY', 'IL'],
  OH: ['MI', 'IN', 'KY', 'WV', 'PA'], KY: ['IN', 'OH', 'WV', 'VA', 'TN', 'MO', 'IL'],
  TN: ['KY', 'VA', 'NC', 'GA', 'AL', 'MS', 'AR', 'MO'], MS: ['LA', 'AR', 'TN', 'AL'],
  AL: ['MS', 'TN', 'GA', 'FL'], GA: ['AL', 'TN', 'NC', 'SC', 'FL'], FL: ['AL', 'GA'],
  SC: ['GA', 'NC'], NC: ['SC', 'GA', 'TN', 'VA'], VA: ['NC', 'TN', 'KY', 'WV', 'MD', 'DC'],
  WV: ['OH', 'PA', 'MD', 'VA', 'KY'], MD: ['VA', 'WV', 'PA', 'DE', 'DC'], DE: ['MD', 'PA', 'NJ'],
  PA: ['NY', 'NJ', 'DE', 'MD', 'WV', 'OH'], NJ: ['NY', 'PA', 'DE'], NY: ['VT', 'MA', 'CT', 'NJ', 'PA'],
  CT: ['NY', 'MA', 'RI'], RI: ['CT', 'MA'], MA: ['NY', 'VT', 'NH', 'RI', 'CT'],
  VT: ['NY', 'NH', 'MA'], NH: ['VT', 'ME', 'MA'], ME: ['NH'], DC: ['MD', 'VA'],
};

/** Great-circle distance. Only meaningful when both sides carry coordinates. */
export function distanceKm(
  a: { latitude?: number | null; longitude?: number | null },
  b: { latitude?: number | null; longitude?: number | null }
): number | null {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return null;
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/**
 * Where this contact sits relative to the project.
 *
 * `unknown` is NOT a synonym for far, and this is the single most important line
 * in the file. Measured on live data, 41% of reachable leads carry no
 * `state_province` at all. Scoring those as distant would quietly demote two
 * fifths of the book for having incomplete source data rather than for being a bad
 * match — punishing the publisher's omission as though it were the contact's fault.
 */
export function geoMatch(contact: ContactFacts, project: ProjectLocation): { geo: GeoMatch; distanceKm: number | null } {
  const km = distanceKm(contact, project);
  const cs = stateCode(contact.state);
  const ps = stateCode(project.stateProvince);

  if (!cs || !ps) return { geo: 'unknown', distanceKm: km };
  if (cs === ps) return { geo: 'same_state', distanceKm: km };
  if ((ADJACENT[cs] ?? []).includes(ps)) return { geo: 'nearby', distanceKm: km };
  return { geo: 'distant', distanceKm: km };
}

/* -------------------------------------------------------------------------- */
/* Employment                                                                  */
/* -------------------------------------------------------------------------- */

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Is this person still there, and did anything just move?
 *
 * Signals are reasons, not a boolean, because the spec asks for the reason to be
 * shown — "recently joined another company" and "title changed here" mean very
 * different things to whoever is about to make the call.
 *
 * A signal lowers confidence rather than excluding, per the spec. The exception is
 * having left: a former employee is not a worse match, they are the wrong person,
 * and no amount of seniority fixes that.
 */
export function employmentAt(
  contact: ContactFacts,
  target: { id?: string | null; name?: string | null },
  now: number = Date.now(),
  recentMonths = 6
): { status: EmploymentStatus; signals: string[] } {
  const history = contact.employment ?? [];
  if (history.length === 0) return { status: 'unknown', signals: [] };

  const signals: string[] = [];
  const atTarget = history.filter((e) => sameCompany({ id: e.organizationId, name: e.organizationName }, target));
  const currentAtTarget = atTarget.find((e) => e.current === true);
  const currentElsewhere = history.find(
    (e) => e.current === true && !sameCompany({ id: e.organizationId, name: e.organizationName }, target)
  );

  if (currentElsewhere) {
    signals.push(`now at ${currentElsewhere.organizationName ?? 'another company'}`);
    const started = currentElsewhere.startDate ? Date.parse(currentElsewhere.startDate) : NaN;
    if (Number.isFinite(started) && now - started < recentMonths * MONTH_MS) {
      signals.push('started that role recently');
    }
  }

  if (atTarget.some((e) => e.endDate && e.current !== true)) signals.push('their role here has an end date');

  /*
    More than one entry at the target company means they moved WITHIN it. Worth
    surfacing rather than ignoring: the title we hold may be the old one, which is
    a different problem from being at the wrong company and is fixed by a re-reveal
    rather than by finding somebody else.
  */
  if (atTarget.length > 1) signals.push('changed role within the company');

  if (currentAtTarget) return { status: 'current', signals };
  if (currentElsewhere || atTarget.length > 0) return { status: 'left', signals };
  return { status: 'unknown', signals };
}

/* -------------------------------------------------------------------------- */
/* The verdict                                                                 */
/* -------------------------------------------------------------------------- */

const GEO_POINTS: Record<GeoMatch, number> = {
  same_state: 30,
  nearby: 18,
  // Above `distant` deliberately. An unlocated contact who is current and
  // well-titled is a better bet than a confirmed-far one, and 41% of leads are
  // unlocated through no fault of the contact.
  unknown: 10,
  distant: 0,
};

const EMPLOYMENT_POINTS: Record<EmploymentStatus, number> = { current: 50, unknown: 25, left: 0 };

/**
 * One number for ordering, and the sentences that produced it.
 *
 * Not a probability, and deliberately not presented as one. Apollo's data is
 * stale in ways nothing here can see, so a number that claimed to be a likelihood
 * would be inventing precision. It orders candidates and it explains itself; that
 * is all it is for.
 */
export function scoreMatch(
  contact: ContactFacts,
  project: ProjectLocation,
  target: { id?: string | null; name?: string | null },
  now: number = Date.now()
): MatchVerdict {
  const { geo, distanceKm: km } = geoMatch(contact, project);
  const { status, signals } = employmentAt(contact, target, now);

  const reasons: string[] = [];
  let score = EMPLOYMENT_POINTS[status] + GEO_POINTS[geo];

  reasons.push(
    status === 'current'
      ? 'currently employed there'
      : status === 'left'
        ? 'no longer appears to work there'
        : 'employment not confirmed'
  );
  reasons.push(
    geo === 'same_state'
      ? 'same state as the project'
      : geo === 'nearby'
        ? 'neighbouring state'
        : geo === 'distant'
          ? km != null
            ? `different state, ${km.toLocaleString()} km away`
            : 'different state'
          : 'location unknown'
  );

  // Each signal costs a little confidence without disqualifying, per the spec.
  for (const s of signals) reasons.push(s);
  score = Math.max(0, score - signals.length * 5);

  /*
    Confidence is about how much we KNOW, not how high the score is. A contact can
    score well on assumptions — unknown employment plus unknown location — and the
    seller needs to be told that is what happened.
  */
  const known = (status !== 'unknown' ? 1 : 0) + (geo !== 'unknown' ? 1 : 0);
  const confidence: MatchVerdict['confidence'] =
    status === 'left' || known === 0 ? 'low' : known === 2 && signals.length === 0 ? 'high' : 'medium';

  return { geo, distanceKm: km, employment: status, signals, score, confidence, reasons };
}

/**
 * Ordering, following the spec — with reachability left to the caller.
 *
 * run.ts already sorts an unreachable contact below a reachable one and its
 * comment explains what that cost to learn: a Project Director with no address
 * became `contact_name` while three contactable people sat unused, and export
 * skipped the record entirely. Nothing here should undo that, so this comparator
 * covers only the part it owns and is applied after reachability.
 */
export function compareVerdicts(a: MatchVerdict, b: MatchVerdict): number {
  if (a.employment !== b.employment) {
    const rank = { current: 2, unknown: 1, left: 0 };
    return rank[b.employment] - rank[a.employment];
  }
  if (a.geo !== b.geo) {
    const rank = { same_state: 3, nearby: 2, unknown: 1, distant: 0 };
    return rank[b.geo] - rank[a.geo];
  }
  return b.score - a.score;
}

/* -------------------------------------------------------------------------- */
/* Selection: better matching may return fewer people, never nobody            */
/* -------------------------------------------------------------------------- */

/**
 * Is this contact good enough to put in front of a seller as the primary?
 *
 * Deliberately a low bar. It rejects the one case that is actively misleading —
 * a person who no longer works there — and nothing else. A distant current
 * employee is a worse match than a local one and still a real person at the right
 * company, so it stays.
 */
export function meetsFloor(v: MatchVerdict): boolean {
  return v.employment !== 'left';
}

/**
 * The company itself, when no person survives the floor.
 *
 * THE RULE IS NEVER NULL.
 *
 * Rejecting a departed contact is right, but if rejection could empty the field
 * the feature would trade handover volume for match quality without anyone
 * choosing that. `run.ts` already records what an unreachable primary costs: a
 * Project Director with no address became `contact_name` while three contactable
 * people sat unused, and export skipped the record entirely.
 *
 * So the fallback is the switchboard, not nothing. Export accepts a record with
 * `contact_phone` and no email — see the `.or(...)` in the export route — so an HQ
 * contact keeps the lead callable and exportable rather than dropping it.
 *
 * This is not a new idea in this codebase. `personPhone()` already falls back to
 * `organization.phone`, and `apolloFindContacts` already takes a `fallbackPhone`
 * for people who carry no number. This makes the same fallback explicit and
 * labelled instead of implicit.
 *
 * Returns null only when the organisation has no phone either — at which point
 * there is genuinely nothing to offer, and saying so beats inventing a contact.
 */
export function hqContact(org: {
  name?: string | null;
  phone?: string | null;
  location?: string | null;
  website?: string | null;
}): { name: string; title: string; phone: string; email: null; source: string; isHq: true } | null {
  if (!org.phone) return null;
  return {
    name: org.name?.trim() || 'Company main line',
    /*
      Titled so nobody mistakes it for a person. A seller who dials this needs to
      know they are calling a switchboard and will have to ask for somebody —
      that is a different call from a direct dial, and the label is the only
      warning they get.
    */
    title: org.location ? `Main line — ${org.location}` : 'Main line',
    phone: org.phone,
    email: null,
    source: 'apollo-hq',
    isHq: true,
  };
}

/**
 * The verdict for an HQ fallback.
 *
 * Always low confidence and explicitly not a person. Its geography is the
 * company's registered location, which is where the head office is rather than
 * where the project is — a Houston switchboard for a Nevada solar farm is normal
 * and should not read as a same-state match.
 */
export function hqVerdict(reason: string): MatchVerdict {
  return {
    geo: 'unknown',
    distanceKm: null,
    employment: 'unknown',
    signals: [],
    score: 5,
    confidence: 'low',
    reasons: ['company switchboard, not a named contact', reason],
  };
}
