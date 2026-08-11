/**
 * Days of cover, per person.
 *
 * `getProductionState` already measures cover for the team as a whole, and a
 * healthy team average hides an empty desk: four people at three days each looks
 * identical to three people at four days and one at nothing. The person with
 * nothing stops working, and the average says the machine is fine.
 *
 * So cover is measured per assignee, against their own quota. Somebody drawing
 * 25 leads a day needs 75 ready to have three days of work; somebody drawing 5
 * needs 15. One number cannot serve both.
 *
 * Pure — no I/O — so the arithmetic is testable and the same rules drive the
 * dashboard, the handover page and how much enrichment gets asked for.
 */

/**
 * The floor, in days.
 *
 * Three rather than one because the pipeline is not instant: a lead has to be
 * enriched, then scored, then assigned, and only then can it be exported. Each
 * of those runs on a schedule, so a buffer of one day is a buffer of zero the
 * moment a single job is late or a source is quiet over a weekend.
 */
export const MIN_DAYS_OF_COVER = 3;

export interface AssigneeCover {
  assigneeId: string;
  name: string;
  dailyQuota: number;
  /** Ready to export now: assigned to them, reachable, not yet sent. */
  ready: number;
  /** What three days of their own draw comes to. */
  target: number;
  /** How many more they need. Zero when covered. */
  deficit: number;
  /** ready / dailyQuota, one decimal. Infinity is reported as null. */
  daysOfCover: number | null;
  short: boolean;
}

export interface SupplyPlan {
  minDays: number;
  people: AssigneeCover[];
  /** Everyone's shortfall added up — what enrichment has to produce. */
  totalDeficit: number;
  /** People below the floor. */
  shortCount: number;
  /** The thinnest desk, which is the one that stops working first. */
  thinnest: AssigneeCover | null;
}

export interface CoverInput {
  assigneeId: string;
  name: string;
  dailyQuota: number;
  ready: number;
  isActive: boolean;
}

/**
 * Who is short, and by how much.
 *
 * Inactive people are excluded rather than reported at zero cover: they are not
 * drawing leads, so counting their empty desk as a shortfall would ask
 * enrichment to spend money supplying somebody who is not working. That
 * distinction matters here — most of this roster is inactive.
 *
 * A quota of zero is the same case. It means "sends nothing", not "needs
 * everything", and dividing by it would report infinite need.
 */
export function planSupply(input: CoverInput[], minDays: number = MIN_DAYS_OF_COVER): SupplyPlan {
  const days = Number.isFinite(minDays) && minDays > 0 ? minDays : MIN_DAYS_OF_COVER;

  const people: AssigneeCover[] = input
    .filter((p) => p.isActive && p.dailyQuota > 0)
    .map((p) => {
      const target = p.dailyQuota * days;
      const deficit = Math.max(0, target - p.ready);
      return {
        assigneeId: p.assigneeId,
        name: p.name,
        dailyQuota: p.dailyQuota,
        ready: p.ready,
        target,
        deficit,
        daysOfCover: Math.round((p.ready / p.dailyQuota) * 10) / 10,
        short: deficit > 0,
      };
    })
    // Thinnest first: the desk that empties soonest is the one to read.
    .sort((a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0) || b.deficit - a.deficit);

  const short = people.filter((p) => p.short);
  return {
    minDays: days,
    people,
    totalDeficit: short.reduce((n, p) => n + p.deficit, 0),
    shortCount: short.length,
    thinnest: people[0] ?? null,
  };
}

/**
 * How many leads enrichment should be asked to produce.
 *
 * The shortfall is in READY leads — assigned and reachable — and enrichment
 * produces neither of those directly: it makes a record contactable, and
 * assignment then has to pick it up. So the ask is inflated to allow for the
 * records enrichment will touch that never become anybody's ready lead, because
 * no contact was found or because nobody's scope covers them.
 *
 * `wastage` is that allowance, not a safety margin for its own sake. At 0.5,
 * asking for 100 ready leads enriches 150.
 */
export function enrichmentAsk(plan: SupplyPlan, opts: { wastage?: number; cap?: number } = {}): number {
  if (plan.totalDeficit <= 0) return 0;
  const wastage = opts.wastage ?? 0.5;
  const ask = Math.ceil(plan.totalDeficit * (1 + Math.max(0, wastage)));
  return opts.cap != null ? Math.min(ask, Math.max(0, opts.cap)) : ask;
}

/** One line an operator can act on, or null when nobody is short. */
export function describeSupply(plan: SupplyPlan): string | null {
  if (plan.shortCount === 0) {
    return plan.people.length === 0 ? null : `Everyone holds at least ${plan.minDays} days of leads.`;
  }
  const worst = plan.people.find((p) => p.short);
  const who =
    plan.shortCount === 1
      ? `${worst?.name} has ${worst?.daysOfCover} day(s)`
      : `${plan.shortCount} people are below ${plan.minDays} days, the thinnest being ${worst?.name} at ${worst?.daysOfCover}`;
  return `${who}. ${plan.totalDeficit.toLocaleString()} more ready lead(s) needed to cover everyone.`;
}
