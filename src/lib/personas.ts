/**
 * The buying committee.
 *
 * Encodes the Evercam LDR Persona & Search Guide so the platform searches the
 * way an LDR is trained to: top of the committee first, widening only when the
 * level above is exhausted. A list of five decision makers is worth more than
 * twenty site engineers, and the ordering here is what makes that the default
 * rather than something a person has to remember.
 *
 * Two axes, not one. The existing enrichment profiles are per SOURCE — who the
 * account is, given where the record came from. This is per SALES PLAY and per
 * BUYING ROLE — which humans inside that account decide, given what we are
 * selling them. Both are needed: the source tells you whose company it is, the
 * play tells you whose signature you need.
 *
 * Pure data and pure functions. No I/O.
 */

/** Where someone sits in the decision, most decisive first. */
export type BuyingRole = 'economic' | 'operational' | 'champion' | 'user' | 'technical';

export const BUYING_ROLES: BuyingRole[] = ['economic', 'operational', 'champion', 'user', 'technical'];

export const ROLE_META: Record<BuyingRole, { label: string; goal: string; priority: number }> = {
  economic: { label: 'Economic buyer', goal: 'Owns the budget', priority: 5 },
  operational: { label: 'Operational buyer', goal: 'Runs the projects', priority: 4 },
  champion: { label: 'Champion', goal: 'Wants Evercam', priority: 3 },
  user: { label: 'User', goal: 'Uses the product', priority: 2 },
  technical: { label: 'Technical', goal: 'Security and IT approval', priority: 1 },
};

/** The plays the guide defines. */
export type SalesPlay =
  | 'data_centres'
  | 'tier1_contractors'
  | 'energy'
  | 'water'
  | 'mining'
  | 'bess'
  | 'key_account_growth';

export const PLAY_LABELS: Record<SalesPlay, string> = {
  data_centres: 'Data centres',
  tier1_contractors: 'Tier 1 contractors',
  energy: 'Energy',
  water: 'Water',
  mining: 'Mining',
  bess: 'Battery energy storage',
  key_account_growth: 'Key account growth',
};

/**
 * Titles per play, per role, in the order an LDR should search them.
 *
 * Order matters inside each list too: the guide is explicit that you exhaust
 * "Director Construction" before "Head of Construction" before "VP
 * Construction", and only reach managers once those are spent.
 */
const PLAY_TITLES: Record<SalesPlay, Partial<Record<BuyingRole, string[]>>> = {
  data_centres: {
    economic: [
      'Director of Construction',
      'Head of Construction',
      'VP Construction',
      'Director of Development',
      'Head of Capital Projects',
    ],
    operational: [
      'Construction Director',
      'Programme Director',
      'Regional Construction Manager',
      'Senior Project Manager',
      'Project Director',
    ],
    champion: [
      'Head of Digital Construction',
      'Innovation Director',
      'VDC Manager',
      'BIM Director',
      'Digital Delivery Manager',
    ],
    user: ['Construction Manager', 'Project Manager', 'Site Manager'],
  },
  tier1_contractors: {
    economic: ['Operations Director', 'Construction Director', 'Regional Director', 'Managing Director', 'VP Operations'],
    operational: ['Project Executive', 'Programme Director', 'Area Director', 'Regional Manager'],
    champion: [
      'Digital Construction',
      'Planning Director',
      'Head of Project Controls',
      'Innovation',
      'Commercial Director',
    ],
    user: ['Project Manager', 'Construction Manager', 'Site Manager'],
  },
  energy: {
    economic: ['Director Capital Delivery', 'Head of Transmission', 'Programme Director', 'Capital Projects Director'],
    operational: ['Programme Manager', 'Project Delivery Manager', 'Construction Manager'],
    champion: ['Digital Delivery', 'Innovation', 'Project Controls', 'Asset Management'],
    user: ['Project Manager', 'Site Manager', 'Resident Engineer'],
  },
  water: {
    economic: ['Capital Delivery Director', 'Engineering Director', 'Head of Capital Programme'],
    operational: ['Programme Manager', 'Framework Manager', 'Senior Project Manager'],
    champion: ['Asset Manager', 'Digital Delivery', 'Innovation'],
    user: ['Project Manager', 'Construction Manager'],
  },
  mining: {
    economic: ['VP Projects', 'Director Major Projects', 'Capital Projects Director'],
    operational: ['Project Director', 'Programme Manager', 'Construction Manager'],
    champion: ['Engineering Manager', 'Innovation Manager', 'Asset Integrity'],
    user: ['Superintendent', 'Project Engineer'],
  },
  bess: {
    economic: ['Director Projects', 'Head of Construction', 'Development Director'],
    operational: ['Construction Manager', 'Programme Manager', 'Project Manager'],
    champion: ['Engineering', 'Grid Connections', 'Innovation'],
    user: ['Site Manager', 'Project Engineer'],
  },
  /**
   * Growth inverts the pyramid: the account is already won, so the search
   * starts at the sponsor who can extend it rather than at whoever builds.
   */
  key_account_growth: {
    economic: ['Executive Sponsor', 'Regional Director', 'Business Unit Leader'],
    operational: ['Project Director', 'Programme Director'],
    champion: ['Digital Construction', 'Innovation', 'Head of Project Controls'],
  },
};

/** Security and IT sign-off, identical across plays. */
const TECHNICAL_TITLES = ['CIO', 'IT Director', 'CISO', 'Head of IT', 'Head of Information Security'];

/**
 * Departments worth searching, most productive first. Tier 1 is always
 * searched; the lower tiers are for accounts with thin data.
 */
export const DEPARTMENT_TIERS: string[][] = [
  ['Construction', 'Capital Projects', 'Operations', 'Programme Delivery', 'Project Delivery', 'Infrastructure Delivery'],
  ['Commercial', 'Claims', 'Planning', 'Project Controls'],
  ['Digital', 'Innovation', 'BIM', 'VDC', 'Transformation'],
  ['Quality', 'Safety', 'Commissioning', 'Logistics'],
  ['IT', 'Legal', 'Security', 'Compliance'],
];

/** Apollo seniorities that satisfy each buying role. */
export const ROLE_SENIORITIES: Record<BuyingRole, string[]> = {
  economic: ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director'],
  operational: ['vp', 'head', 'director', 'manager'],
  champion: ['head', 'director', 'manager'],
  user: ['manager', 'senior'],
  technical: ['c_suite', 'vp', 'head', 'director'],
};

export function titlesFor(play: SalesPlay, role: BuyingRole): string[] {
  if (role === 'technical') return TECHNICAL_TITLES;
  return PLAY_TITLES[play]?.[role] ?? [];
}

/**
 * Every title for a play, ordered by how decisive the role is.
 *
 * This is what goes to Apollo: search the whole committee at once but ranked,
 * so when the result set is trimmed it is the site engineers that fall off the
 * end rather than the budget holder.
 */
export function searchTitles(play: SalesPlay, roles: BuyingRole[] = BUYING_ROLES): string[] {
  const out: string[] = [];
  for (const role of [...roles].sort((a, b) => ROLE_META[b].priority - ROLE_META[a].priority)) {
    for (const t of titlesFor(play, role)) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * A title's role when no play is named.
 *
 * The guide deliberately places the same title differently per play — a
 * Programme Director is an economic buyer in Energy and an operational one in
 * Data Centres; a Project Manager is operational for BESS and a user in three
 * other plays. Scanning every play in role order therefore made the answer
 * depend on which play happened to be checked first, which is not an answer at
 * all.
 *
 * So without a play, the role is the one the guide assigns MOST OFTEN, and a
 * tie resolves to the more junior reading. Over-promoting a title is the worse
 * error: it makes a list look like it has a budget holder when it does not.
 */
const CANONICAL_ROLE: Map<string, BuyingRole> = (() => {
  const tally = new Map<string, Partial<Record<BuyingRole, number>>>();
  for (const play of Object.keys(PLAY_TITLES) as SalesPlay[]) {
    for (const role of BUYING_ROLES) {
      for (const title of titlesFor(play, role)) {
        const key = title.toLowerCase();
        const counts = tally.get(key) ?? {};
        counts[role] = (counts[role] ?? 0) + 1;
        tally.set(key, counts);
      }
    }
  }

  const out = new Map<string, BuyingRole>();
  for (const [title, counts] of tally) {
    let best: BuyingRole | null = null;
    for (const role of BUYING_ROLES) {
      const n = counts[role] ?? 0;
      if (n === 0) continue;
      // Strictly greater keeps the earlier (more senior) role only when it
      // genuinely appears more often; ties fall through to the junior one.
      if (!best || n > (counts[best] ?? 0)) best = role;
    }
    if (best) out.set(title, best);
  }
  return out;
})();

/**
 * Which buying role a title represents.
 *
 * With a play, that play's own lists decide — they are the authority for how
 * this business sells into that segment. Without one, the canonical mapping
 * above decides. Generic seniority words are the last resort, so a title
 * nobody listed still lands somewhere defensible rather than being dropped.
 *
 * Returns null when a title is too junior or too unrelated to belong on a list
 * at all — which is what "only qualified titles" has to mean in practice.
 */
export function classifyTitle(title: string | null | undefined, play?: SalesPlay): BuyingRole | null {
  const t = (title ?? '').toLowerCase().trim();
  if (!t) return null;

  if (play) {
    for (const role of BUYING_ROLES) {
      if (titlesFor(play, role).some((known) => t.includes(known.toLowerCase()))) return role;
    }
  } else {
    // Longest match first, so "Senior Project Manager" is not read as
    // "Project Manager" when the guide ranks them differently.
    const known = [...CANONICAL_ROLE.keys()].sort((a, b) => b.length - a.length);
    for (const k of known) if (t.includes(k)) return CANONICAL_ROLE.get(k)!;
  }

  if (/\b(cio|ciso|it director|information security)\b/.test(t)) return 'technical';
  if (/\b(digital|innovation|bim|vdc|project controls|transformation)\b/.test(t)) return 'champion';
  if (/\b(ceo|cfo|coo|managing director|president|owner|founder|chief)\b/.test(t)) return 'economic';
  if (/\b(vp|vice president|head of|director)\b/.test(t)) return 'economic';
  if (/\b(programme|program|project)\s+(director|executive)\b/.test(t)) return 'operational';
  if (/\b(senior manager|general manager|area manager|regional manager)\b/.test(t)) return 'operational';
  if (/\b(project manager|construction manager|site manager|superintendent|project engineer)\b/.test(t)) return 'user';

  return null;
}

/** Whether a title belongs on a BDR-ready list at all. */
export function isQualifiedTitle(title: string | null | undefined, play?: SalesPlay): boolean {
  return classifyTitle(title, play) !== null;
}

/** How many of each role a complete list needs. */
export type AccountSize = 'enterprise' | 'mid_market';

export const COVERAGE_TARGET: Record<AccountSize, Partial<Record<BuyingRole, number>>> = {
  enterprise: { economic: 2, operational: 2, champion: 2, user: 2 },
  mid_market: { economic: 1, operational: 1, champion: 1, user: 1 },
};

export interface CoverageReport {
  size: AccountSize;
  /** Contacts found per role. */
  found: Record<BuyingRole, number>;
  /** Roles still short of target, most decisive first. */
  missing: { role: BuyingRole; need: number }[];
  total: number;
  target: number;
  complete: boolean;
}

/**
 * Whether an account is ready to hand to a BDR.
 *
 * The guide's standard is a shape, not a count: eight contacts that are all
 * project managers is not a complete list, because nobody in it can sign
 * anything. So this reports per role and calls the account complete only when
 * every role clears its minimum.
 */
export function coverageFor(
  contacts: { title?: string | null }[],
  size: AccountSize = 'enterprise',
  play?: SalesPlay
): CoverageReport {
  const found: Record<BuyingRole, number> = { economic: 0, operational: 0, champion: 0, user: 0, technical: 0 };
  for (const c of contacts) {
    const role = classifyTitle(c.title, play);
    if (role) found[role] += 1;
  }

  const targets = COVERAGE_TARGET[size];
  const missing = BUYING_ROLES.filter((r) => (targets[r] ?? 0) > found[r])
    .map((role) => ({ role, need: (targets[role] ?? 0) - found[role] }))
    .sort((a, b) => ROLE_META[b.role].priority - ROLE_META[a.role].priority);

  const target = Object.values(targets).reduce((n, v) => n + (v ?? 0), 0);

  return {
    size,
    found,
    missing,
    total: BUYING_ROLES.reduce((n, r) => n + found[r], 0),
    target,
    complete: missing.length === 0,
  };
}

/** The play a record belongs to, from its vertical and ICP. */
export function playFor(vertical: string | null | undefined, icp?: string | null): SalesPlay {
  const v = (vertical ?? '').toLowerCase();
  if (v === 'data_center' || v === 'semiconductor') return 'data_centres';
  if (v === 'battery') return 'bess';
  if (v === 'mining' || v === 'steel' || v === 'cement') return 'mining';
  if (['solar', 'wind', 'nuclear', 'hydro', 'coal', 'oil_gas', 'pipeline', 'bioenergy', 'power'].includes(v)) {
    return 'energy';
  }
  if (icp === 'tier1_gc' || icp === 'tier2_gc') return 'tier1_contractors';
  return 'tier1_contractors';
}
