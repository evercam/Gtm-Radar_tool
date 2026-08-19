/**
 * One phase vocabulary, from ten.
 *
 * `current_phase` carries 117 distinct values because every source names things
 * its own way: `planning_ie` contributes about eighty administrative workflow
 * states ("35 Day Assessment", "Invalid Details Sent to Applicant"),
 * `nyc_dob_permits` says IN PROCESS, `gem_energy_tracker` says Mothballed, the
 * tender feeds say Awarded, `world_bank` says Pipeline. Nobody can filter on that,
 * and it is too many for an Apollo picklist.
 *
 * Several are not even distinct: "Decision Issued" appears 211 times and again 125
 * times with trailing spaces, and the same is true of Final Grant, Referral, 35 Day
 * Assessment, Recommendation Review, Invalid Application and Application Withdrawn.
 * Trimming alone removes a chunk of the 117.
 *
 * The canonical set is ordered the way a build actually progresses, because the
 * question a rep is really asking is "how close is this to breaking ground" —
 * cameras go in at mobilisation.
 *
 * An unrecognised value maps to null and is REPORTED rather than guessed into the
 * nearest bucket. A phase quietly filed as "Planned" when it means something else
 * is worse than one left blank: the blank is visible and the wrong answer is not.
 *
 * THIS FILE IS THE SOURCE. `EXACT` and `RULES` are exported because Postgres needs
 * the same mapping — a phase column the database can index, so filtering on phase
 * is a WHERE clause instead of fetching two thousand rows and folding them here.
 * The SQL is GENERATED from these two structures by
 * `scripts/generate-phase-sql.mjs`; it is never hand-written, because a second
 * copy of a 117-value mapping is a copy that drifts. Change a rule here, re-run
 * the generator, ship the migration. `scripts/test-phase-parity.mjs` asserts the
 * two agree on every distinct value actually present in the table.
 */

export const PROJECT_PHASES = [
  'Planned',
  'Permitting',
  'Approved',
  'Tendering',
  'Awarded',
  'Pre-construction',
  'Under construction',
  'Operating',
  'Retired',
  'On hold',
  'Cancelled',
] as const;

export type ProjectPhase = (typeof PROJECT_PHASES)[number];

/** Trim, collapse inner runs of whitespace, lowercase. */
const key = (raw: string): string => raw.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Exact matches, keyed on the normalised form.
 *
 * Explicit beats clever: every value here was observed in the data, so a rule that
 * would have caught it by accident cannot quietly reclassify it later.
 */
export const EXACT: Record<string, ProjectPhase> = {
  // gem_energy_tracker
  proposed: 'Planned',
  announced: 'Planned',
  discovered: 'Planned',
  'in-development': 'Planned',
  'pre-permit': 'Permitting',
  'pre-construction': 'Pre-construction',
  construction: 'Under construction',
  operating: 'Operating',
  'operating pre-retirement': 'Operating',
  retired: 'Retired',
  mothballed: 'On hold',
  shelved: 'On hold',
  idle: 'On hold',
  idled: 'On hold',
  cancelled: 'Cancelled',

  // project_intelligence
  permitting: 'Permitting',
  'under construction': 'Under construction',
  commissioning: 'Under construction',
  'on hold': 'On hold',

  // tender / award feeds
  tender: 'Tendering',
  awarded: 'Awarded',
  'contract awarded': 'Awarded',

  // nyc_dob_permits + chicago_building_permits
  'in process': 'Permitting',
  issued: 'Approved',
  're-issued': 'Approved',

  // glenigan
  'early planning': 'Planned',
  'plans approved': 'Approved',

  // world_bank
  pipeline: 'Planned',
  active: 'Under construction',
  closed: 'Operating',
  dropped: 'Cancelled',

  // news feeds
  announcement: 'Planned',

  /*
    NESO grid-connection registers (TEC, Embedded).

    "Consents Approved" and "Under Construction/Commissioning" already resolved
    through the rules, but the other three did not — and unmapped means a phase
    of null, which is invisible to the timing score. Since timing is the heaviest
    weight in scoring, a 2037 scoping project and a site breaking ground next
    quarter would have looked identical.
  */
  /*
    Calgary building permits.

    "Pre Backfill Phase" is the useful one and the least obvious: the foundation
    is in and the hole is still open, which is the earliest point a camera is
    worth anything. It is under construction, not planned.
  */
  'pre backfill phase': 'Under construction',
  'pre board phase': 'Under construction',
  'issued permit': 'Approved',
  completed: 'Operating',
  hold: 'On hold',
  refused: 'Cancelled',
  'pending plans review': 'Permitting',
  'pending plans review assignment': 'Permitting',
  new: 'Planned',

  scoping: 'Planned',
  'awaiting consents': 'Permitting',
  'consents approved': 'Approved',
  'under construction/commissioning': 'Under construction',
  built: 'Operating',

  // planning_ie — the decision outcomes that actually change a project's state
  'final grant': 'Approved',
  'final grant review': 'Approved',
  'decision issued': 'Approved',
  'decision notice issued': 'Approved',
  'decision made': 'Approved',
  'application finalised': 'Approved',
  withdrawn: 'Cancelled',
  'application withdrawn': 'Cancelled',
  appealed: 'Permitting',
  'appealed financial': 'Permitting',
  'decision appealed': 'Permitting',
  'application under appeal': 'Permitting',
  'further information': 'Permitting',
  valid: 'Permitting',
  'n/a': 'Planned',
};

/**
 * Fallback patterns, applied in order, only when nothing matched exactly.
 *
 * These exist for `planning_ie`, whose eighty-odd states are all one thing to a
 * rep: an application working through the process. Enumerating every one would be
 * a list that goes stale the moment the council adds a step.
 */
export const RULES: { pattern: RegExp; phase: ProjectPhase }[] = [
  /*
    gem_energy_tracker suffixes its inferred states — "Shelved - Inferred 2 Y",
    "Cancelled - Inferred 4 Y" — so the prefix is what carries the meaning. Placed
    first because "shelved" must not fall through to a later pattern.
  */
  { pattern: /^shelved/, phase: 'On hold' },
  { pattern: /^idle/, phase: 'On hold' },
  // A closed-out invalid application is dead; one still being corrected is not.
  { pattern: /invalid.*(case closed)/, phase: 'Cancelled' },
  { pattern: /^(incompleted|unregistered)/, phase: 'Permitting' },
  { pattern: /invalid/, phase: 'Permitting' },
  { pattern: /withdraw/, phase: 'Cancelled' },
  { pattern: /cancel/, phase: 'Cancelled' },
  // Every assessment, validation, referral, recommendation and AI step.
  {
    pattern:
      /(applica|assessment|validat|referral|recommend|registrat|registered|planner|officer|appeal|\bai\b|cai|sai|consultee|publication|pre-reg|decision|report|comments|prepare|approval|review|request|received|requested|notice)/,
    phase: 'Permitting',
  },
  { pattern: /(grant|approved|permit)/, phase: 'Approved' },
  { pattern: /construct/, phase: 'Under construction' },
];

export interface PhaseMatch {
  phase: ProjectPhase | null;
  /** How it was decided, so an unexpected mapping can be traced. */
  via: 'exact' | 'rule' | 'unmapped';
}

export function matchPhase(raw: string | null | undefined): PhaseMatch {
  if (!raw?.trim()) return { phase: null, via: 'unmapped' };
  const k = key(raw);
  const exact = EXACT[k];
  if (exact) return { phase: exact, via: 'exact' };
  for (const { pattern, phase } of RULES) {
    if (pattern.test(k)) return { phase, via: 'rule' };
  }
  return { phase: null, via: 'unmapped' };
}

/** The phase alone, or null. The common case. */
export function normalisePhase(raw: string | null | undefined): ProjectPhase | null {
  return matchPhase(raw).phase;
}
