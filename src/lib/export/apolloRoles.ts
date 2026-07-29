/**
 * Reading a roster entry out of an Apollo user record.
 *
 * Apollo carries two things this app otherwise makes an admin retype: a job
 * title, and a prospect territory. Both are already the answer to a question
 * the roster asks — what role is this person, and which business unit do they
 * work — so deriving them removes the step where the two systems drift apart.
 *
 * Deliberately a suggestion, never an imposition: the mapping is applied to
 * pre-fill the form, and the admin can overrule it before saving. A title is
 * free text in Apollo and always will be.
 *
 * Pure and dependency-free so it can be exercised directly — see
 * scripts/test-apollo-roles.mjs.
 */

export type RosterRole = 'bdr' | 'sdr' | 'ae' | 'marketing' | 'sales_manager';

/**
 * Ordered, and the order carries the logic.
 *
 * "Key Account Manager" contains both "account" and "manager"; matching the
 * seniority words first would file every AE under sales_manager. So the
 * individual-contributor patterns are tested before the leadership ones, and
 * the first match wins.
 */
const TITLE_RULES: { pattern: RegExp; role: RosterRole }[] = [
  // Lead/business development — the people this tool exists to feed.
  { pattern: /\bldr\b|lead development/i, role: 'bdr' },
  { pattern: /\bbdr\b|business development (rep|exec)/i, role: 'bdr' },
  { pattern: /\bsdr\b|sales development/i, role: 'sdr' },

  // Closers. Matched before anything that looks like leadership, because
  // "Key Account Manager" and "Account Manager" are both quota-carrying ICs.
  { pattern: /account (executive|manager)/i, role: 'ae' },
  { pattern: /\bae\b/i, role: 'ae' },

  // Leadership. "Team Lead", "Head of", "Director", "VP", "Chief".
  { pattern: /team lead|head of|managing director|\bdirector\b|\bvp\b|chief|founder/i, role: 'sales_manager' },
  { pattern: /sales manager/i, role: 'sales_manager' },

  { pattern: /marketing|demand gen|growth/i, role: 'marketing' },
];

/** The role a title implies, or null when it implies nothing. */
export function roleFromTitle(title: string | null | undefined): RosterRole | null {
  const t = (title ?? '').trim();
  if (!t) return null;
  for (const { pattern, role } of TITLE_RULES) {
    if (pattern.test(t)) return role;
  }
  return null;
}

/**
 * Apollo's territory names against this app's business units.
 *
 * ANZ folds into APAC: Apollo separates them, this app's `BUSINESS_UNITS` does
 * not, and dropping the person's territory entirely would be worse than
 * placing them in the nearest unit that exists.
 */
const TERRITORY_MAP: { pattern: RegExp; bu: string }[] = [
  { pattern: /^(usa|us|united states|north america|namer)$/i, bu: 'usa' },
  { pattern: /^(uk|united kingdom|gb|britain)$/i, bu: 'uk' },
  { pattern: /^(ireland|ie|eire|roi)$/i, bu: 'ireland' },
  { pattern: /^(apac|anz|asia|australia|new zealand|japan)$/i, bu: 'apac' },
  { pattern: /^(emea|europe|export|row|rest of world|latam|mena)$/i, bu: 'export' },
];

/** The business unit a territory name implies, or null. */
export function buFromTerritory(territory: string | null | undefined): string | null {
  const t = (territory ?? '').trim();
  if (!t) return null;
  for (const { pattern, bu } of TERRITORY_MAP) {
    if (pattern.test(t)) return bu;
  }
  return null;
}

/** Every business unit a person's territories map to, de-duplicated and ordered. */
export function buFromTerritories(territories: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const t of territories ?? []) {
    const bu = buFromTerritory(t);
    if (bu && !out.includes(bu)) out.push(bu);
  }
  return out;
}

export interface RosterSuggestion {
  role: RosterRole;
  bu: string[];
  /** What the suggestion was read from, so the UI can show its reasoning. */
  because: string | null;
}

/**
 * The roster defaults for an Apollo user.
 *
 * Falls back to `bdr` rather than refusing to suggest: it is the most common
 * receiving role and the least privileged of them, so a wrong guess costs a
 * dropdown change rather than access somebody should not have had.
 */
export function suggestRoster(user: {
  title?: string | null;
  territories?: readonly string[] | null;
}): RosterSuggestion {
  const role = roleFromTitle(user.title);
  const bu = buFromTerritories(user.territories);

  const reasons: string[] = [];
  if (role && user.title) reasons.push(`“${user.title.trim()}”`);
  if (bu.length && user.territories?.length) reasons.push(user.territories.join(', '));

  return {
    role: role ?? 'bdr',
    bu,
    because: reasons.length ? reasons.join(' · ') : null,
  };
}
