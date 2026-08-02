/**
 * Every domain vocabulary the UI renders as a coloured chip, in one place.
 *
 * These maps used to be re-declared in SourceSearch.tsx, records/page.tsx,
 * enrichment/page.tsx, lib/format.ts and lib/priority.ts. Each copy drifted:
 * the same business unit rendered purple in one table and violet in another,
 * and a priority band's colour was defined twice. Import from here instead of
 * writing a new map.
 *
 * Values are Tailwind class strings rather than tokens because chips need a
 * paired background and foreground per state, which a single CSS variable
 * cannot express.
 */

export type ChipClass = string;

/** Priority band — the lead work queue. See lib/priority.ts for the scoring. */
export const BAND_COLORS: Record<string, ChipClass> = {
  P1: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
  P2: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  P3: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  P4: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
};

/**
 * How early we are arriving, relative to the moment Evercam gets installed.
 *
 * Green for the two verdicts worth a call, red for the ones that are over.
 * Deliberately NOT the same palette as the priority band — a P1 that is already
 * built is not a lead, and if the two read alike that contradiction disappears.
 */
export const ARRIVAL_COLORS: Record<string, ChipClass> = {
  early: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  on_time: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
  late: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  too_late: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  unknown: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400',
};

export const ARRIVAL_LABELS: Record<string, string> = {
  early: 'early',
  on_time: 'on time',
  late: 'late',
  too_late: 'too late',
  unknown: 'no date',
};

export const BAND_LABELS: Record<string, string> = {
  P1: 'Act now',
  P2: 'Work this week',
  P3: 'Nurture',
  P4: 'Backlog',
};

/** Hot / Warm / Cold, the spec's vocabulary for the same bands. */
export const BAND_TEMPERATURE: Record<string, string> = {
  P1: 'Hot',
  P2: 'Hot',
  P3: 'Warm',
  P4: 'Cold',
};

/** Business unit — geographic in this product (see PLATFORM_UPGRADE_PROMPT). */
export const BU_LABELS: Record<string, string> = {
  usa: 'USA',
  uk: 'UK',
  ireland: 'Ireland',
  apac: 'APAC',
  export: 'Export',
};

export const BU_SHORT: Record<string, string> = {
  usa: 'USA',
  uk: 'UK',
  ireland: 'IE',
  apac: 'APAC',
  export: 'EXP',
};

export const BU_COLORS: Record<string, ChipClass> = {
  usa: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  uk: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  ireland: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  apac: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300',
  export: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-300',
};

export const BUSINESS_UNITS = ['usa', 'uk', 'ireland', 'apac', 'export'] as const;

/** What kind of record a row represents. */
export const RECORD_TYPE_COLORS: Record<string, ChipClass> = {
  project: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  tender: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
  permit: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
  filing: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  news: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
  account: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  contact: 'bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-300',
  signal: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

export const RECORD_TYPES = ['account', 'project', 'tender', 'permit', 'filing', 'news', 'signal'] as const;

/** Data completeness tier, A (complete) to E (signal only). */
export const TIER_COLORS: Record<string, ChipClass> = {
  A: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  B: 'bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-300',
  C: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  D: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  E: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
};

export const TIER_LABELS: Record<string, string> = {
  A: 'Complete Information',
  B: 'Mostly Complete',
  C: 'Partial Information',
  D: 'Minimal Information',
  E: 'Signal Only',
};

/** Disposition lane — who owns the record and what to do with it. */
export const ROUTE_COLORS: Record<string, ChipClass> = {
  sales: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  marketing: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  partner: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
  none: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
};

export const ROUTE_TEXT: Record<string, string> = {
  sales: 'text-emerald-700 dark:text-emerald-300',
  marketing: 'text-amber-700 dark:text-amber-300',
  partner: 'text-violet-700 dark:text-violet-300',
  none: 'text-zinc-500 dark:text-zinc-400',
};

export const ROUTES = ['sales', 'marketing', 'partner', 'none'] as const;
export const STAGES = ['act_now', 'qualify', 'nurture', 'hold', 'disqualify'] as const;

/** Health of a source adapter. */
export const HEALTH_COLORS: Record<string, ChipClass> = {
  healthy: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  degraded: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  failing: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
  disabled: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  unconfigured: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
};

/** Whether a record can be actioned today. */
export const CONTACT_STATUS_COLORS: Record<string, ChipClass> = {
  has_contact: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  needs_enrichment: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
};

/** ICP code → display label. */
export const ICP_LABELS: Record<string, string> = {
  mission_critical_owner: 'Mission-Critical Owner',
  critical_infra_owner: 'Critical Infrastructure Owner',
  tier1_gc: 'Tier 1 GC',
  tier2_gc: 'Tier 2 GC',
  developer: 'Developer',
};

/**
 * Verticals the classifier can assign. Mirrors VERTICAL_CODE in lib/classify.ts,
 * which is server-only — this list is the client-safe copy the rule builder
 * offers as choices.
 */
export const VERTICALS = [
  'data_center',
  'semiconductor',
  'battery',
  'solar',
  'wind',
  'nuclear',
  'hydro',
  'bioenergy',
  'power',
  'pharma',
  'pipeline',
  'coal',
  'oil_gas',
  'mining',
  'steel',
  'cement',
  'chemicals',
  'procurement',
  'construction',
  'market_intel',
  'capital_markets',
] as const;

export const PRIORITY_BANDS = ['P1', 'P2', 'P3', 'P4'] as const;

/** Fallback chip styling for a status the UI doesn't recognise. */
export const STATUS_COLORS_SAFE = 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';

/** snake_case → Title Case, for values with no explicit label. */
export function titleize(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
