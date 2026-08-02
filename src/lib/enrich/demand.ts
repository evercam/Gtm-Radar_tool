import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { userCoversLead, type AssignableLead, type AssignableUser } from '@/lib/assignment';
import { getEnrichmentQueue, type EnrichQueueFilters, type EnrichQueueRow } from '@/lib/queries';

/**
 * What the team actually needs enriched — per person, not in aggregate.
 *
 * The enrichment queue orders by priority score across the whole book, which is
 * the right answer to "which lead is most valuable" and the wrong answer to
 * "what should we produce next". Those diverge as soon as anybody has a scope.
 *
 * Concretely: one rep covers mining, the rest cover everything. Score-ordered
 * filling produces whatever happens to rank highest — mostly solar and data
 * centres, because that is where the large capital projects are. The tank reads
 * full, the aggregate numbers look healthy, and the mining rep has nothing to
 * call. Nothing in the pipeline notices, because nothing was measuring per
 * person.
 *
 * So demand is computed per roster entry: their own quota times the reserve, less
 * what is already sitting ready that their scope actually covers. The deficit is
 * what to go and make.
 *
 * Scales with the roster by construction. A sixth person, a changed quota, a new
 * vertical — all move the plan without touching this file.
 */

export interface PersonDemand {
  id: string;
  name: string;
  /** Their own daily_lead_quota. */
  dailyQuota: number;
  /** This person's share of the month's target, weighted by their quota. */
  target: number;
  /** Ready leads whose vertical/region/BU this person can be given. */
  covered: number;
  /** target - covered, floored at zero. What to produce for them. */
  deficit: number;
  /**
   * Days this person could keep working from what is already in stock for them.
   *
   * `covered / dailyQuota` — the number a manager actually wants, because "7
   * leads" means nothing without knowing they burn 10 a day. Zero when they have
   * no quota, since an unlimited runway is not a meaningful figure.
   */
  daysOfCover: number;
  /** The scope itself, so a caller can explain a deficit it cannot fill. */
  scope: { bu: string[]; verticals: string[]; regions: string[] };
}

export interface DemandPlan {
  people: PersonDemand[];
  /** Sum of every person's target. */
  totalTarget: number;
  /** Sum of every deficit — the real size of the job. */
  totalDeficit: number;
  /**
   * People whose deficit cannot be filled from the eligible pool at all, with
   * the reason. A rep scoped to a vertical no source covers would otherwise
   * starve in silence.
   */
  unfillable: Array<{ name: string; reason: string }>;
}

/** The roster columns that decide scope, mapped to the shape assignment.ts uses. */
function toAssignable(row: Record<string, unknown>): AssignableUser {
  const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]).filter((x) => typeof x === 'string') : []);
  return {
    id: String(row.id),
    name: (row.name as string) ?? undefined,
    userId: (row.user_id as string) ?? null,
    role: (row.role as string) ?? 'bdr',
    bu: list(row.bu),
    // `preferred_verticals` is the softer of the two and only narrows when
    // `verticals` is empty — a preference should shape what we PRODUCE without
    // becoming a hard filter that hides leads from somebody.
    verticals: list(row.verticals).length ? list(row.verticals) : list(row.preferred_verticals),
    regions: list(row.regions),
    dailyQuota: (row.daily_lead_quota as number) ?? 0,
    assignedToday: 0,
    isActive: row.is_active === true,
  };
}

/**
 * Ready inventory, as leads the scope test can be applied to.
 *
 * Only the fields `userCoversLead` reads, and only records enrichment produced
 * and export has not consumed — the same definition `getBufferState` uses, so
 * the two cannot disagree about what "ready" means.
 */
async function readyInventory(): Promise<AssignableLead[]> {
  const service = getServiceSupabase();
  const out: AssignableLead[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await service
      .from('canonical_projects')
      .select('id, bu, vertical, country, priority_band, priority_score, stage, contact_status, owner_user_id')
      .not('enriched_at', 'is', null)
      .not('contact_email', 'is', null)
      .is('apollo_exported_at', null)
      .eq('do_not_contact', false)
      // Ordered, because an unordered .range() walk repeats and skips rows — which
      // here would miscount somebody's cover and send us producing leads they
      // already have.
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn(`Could not read ready inventory: ${error.message}`);
      break;
    }
    out.push(...((data ?? []) as unknown as AssignableLead[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function getDemandPlan(monthlyReadyTarget: number): Promise<DemandPlan> {
  const empty: DemandPlan = { people: [], totalTarget: 0, totalDeficit: 0, unfillable: [] };
  if (!isSupabaseServiceConfigured()) return empty;

  const service = getServiceSupabase();
  const { data: rows, error } = await service
    .from('assignees')
    .select('id, name, role, bu, verticals, preferred_verticals, regions, daily_lead_quota, is_active, user_id')
    .eq('is_active', true);
  if (error) {
    console.warn(`Could not read the roster: ${error.message}`);
    return empty;
  }

  const roster = (rows ?? []).map((r) => toAssignable(r as Record<string, unknown>)).filter((u) => u.dailyQuota > 0);
  if (roster.length === 0) return empty;

  const inventory = await readyInventory();

  // Each person's share of the month's production, weighted by their quota. Five
  // people on fifty a day split 7,200 evenly at 1,440 each; a sixth joining or a
  // quota changing re-splits it without anybody editing a number.
  const totalQuota = roster.reduce((n, u) => n + u.dailyQuota, 0);

  const people: PersonDemand[] = roster.map((u) => {
    const covered = inventory.filter((lead) => userCoversLead(u, lead)).length;
    const target = totalQuota > 0 ? Math.round(monthlyReadyTarget * (u.dailyQuota / totalQuota)) : 0;
    return {
      id: u.id,
      name: u.name ?? u.id,
      dailyQuota: u.dailyQuota,
      target,
      covered,
      deficit: Math.max(0, target - covered),
      daysOfCover: u.dailyQuota > 0 ? Math.round((covered / u.dailyQuota) * 10) / 10 : 0,
      scope: { bu: u.bu, verticals: u.verticals, regions: u.regions },
    };
  });

  return {
    people,
    totalTarget: people.reduce((n, p) => n + p.target, 0),
    totalDeficit: people.reduce((n, p) => n + p.deficit, 0),
    unfillable: [],
  };
}

/**
 * Who to produce for next, in proportion to how short each person is.
 *
 * Proportional by deficit, allocated by largest remainder. With Anas short 1,190
 * and Ronniel short 233, ten slots split 8 / 2 — which is also their quota ratio,
 * as it should be when both are equally far from target.
 *
 * The first version of this took from whoever was furthest behind and recomputed,
 * which sounds fair and is not: it gave all ten slots to Anas, because after ten
 * picks he was still 1,180 short against Ronniel's 233. A rep on a narrow scope
 * has a small absolute deficit by definition and would never be reached. Caught
 * by running it against the real roster, not by reading it.
 *
 * Anyone with a deficit gets at least one slot while slots allow, so a small
 * share is never rounded out of existence.
 */
export function fillOrder(plan: DemandPlan, slots: number): PersonDemand[] {
  const short = plan.people.filter((p) => p.deficit > 0);
  if (short.length === 0 || slots <= 0) return [];

  const totalDeficit = short.reduce((n, p) => n + p.deficit, 0);

  // Exact proportional share, then the floor, then hand out what rounding left
  // over to the largest remainders — so the counts always sum to `slots`.
  const shares = short.map((p) => {
    const exact = (p.deficit / totalDeficit) * slots;
    return { person: p, exact, whole: Math.floor(exact) };
  });

  // A guaranteed floor of one, but only while there are enough slots to go round;
  // with fewer slots than people, proportion alone decides who is served first.
  if (slots >= short.length) for (const s of shares) if (s.whole === 0) s.whole = 1;

  let assigned = shares.reduce((n, s) => n + s.whole, 0);
  // Trim from the largest holders if the floor pushed us over.
  while (assigned > slots) {
    const biggest = shares.filter((s) => s.whole > 1).sort((a, b) => b.whole - a.whole)[0];
    if (!biggest) break;
    biggest.whole -= 1;
    assigned -= 1;
  }
  // Distribute the remainder to whoever was rounded down hardest.
  const byRemainder = [...shares].sort((a, b) => (b.exact - b.whole) - (a.exact - a.whole));
  let i = 0;
  while (assigned < slots && byRemainder.length) {
    byRemainder[i % byRemainder.length].whole += 1;
    assigned += 1;
    i += 1;
  }

  // Interleaved rather than blocked, so a batch cut short by a timeout still
  // produced something for everybody instead of everything for the first person.
  const order: PersonDemand[] = [];
  const counts = new Map(shares.map((s) => [s.person.id, s.whole]));
  while (order.length < slots) {
    let placed = false;
    for (const s of shares) {
      const left = counts.get(s.person.id) ?? 0;
      if (left > 0) {
        order.push(s.person);
        counts.set(s.person.id, left - 1);
        placed = true;
        if (order.length >= slots) break;
      }
    }
    if (!placed) break;
  }
  return order;
}

export interface DemandFill {
  rows: EnrichQueueRow[];
  /** How many records were found for each person, by name. */
  perPerson: Record<string, number>;
  /**
   * People the pool could not serve, with what they were asking for. A rep scoped
   * to a vertical no source covers has a real deficit and an empty result, and
   * that is a sourcing problem — it must not look like a full tank.
   */
  starved: Array<{ name: string; wanted: number; scope: PersonDemand['scope'] }>;
  unreachableSkipped: number;
}

/**
 * The next batch, chosen by who needs it rather than by score alone.
 *
 * One queue read per person, each narrowed to that person's scope and limited to
 * their share of the slots. Within a person the ordering is still priority score,
 * so this changes WHO the batch is for without lowering the bar for what gets
 * picked.
 *
 * Falls back to the plain score-ordered queue when nobody has a quota — an
 * install with an empty roster should still be able to enrich.
 */
export async function planDemandFill(
  filters: EnrichQueueFilters,
  plan: DemandPlan,
  slots: number
): Promise<DemandFill> {
  const order = fillOrder(plan, slots);
  if (order.length === 0) {
    const q = await getEnrichmentQueue({ ...filters, limit: slots });
    return { rows: q.rows, perPerson: {}, starved: [], unreachableSkipped: q.unreachableSkipped };
  }

  // Slots per person, from the interleaved order.
  const want = new Map<string, number>();
  for (const p of order) want.set(p.id, (want.get(p.id) ?? 0) + 1);

  const seen = new Set<string>();
  const rows: EnrichQueueRow[] = [];
  const perPerson: Record<string, number> = {};
  const starved: DemandFill['starved'] = [];
  let unreachableSkipped = 0;

  for (const [id, count] of want) {
    const person = plan.people.find((p) => p.id === id);
    if (!person) continue;

    // Their scope INTERSECTED with the policy's, not replacing it — a person
    // scoped to a vertical the policy excludes must not smuggle it back in.
    const narrowed: EnrichQueueFilters = {
      ...filters,
      bus: person.scope.bu.length ? intersect(filters.bus, person.scope.bu) : filters.bus,
      verticals: person.scope.verticals.length ? intersect(filters.verticals, person.scope.verticals) : filters.verticals,
      countries: person.scope.regions.length ? person.scope.regions : filters.countries,
      // Over-fetch a little: another person may already have claimed some of
      // these, and a scoped read is cheap.
      limit: Math.min(500, count * 3),
    };

    const q = await getEnrichmentQueue(narrowed);
    unreachableSkipped += q.unreachableSkipped;

    let taken = 0;
    for (const r of q.rows) {
      if (taken >= count) break;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
      taken += 1;
    }
    perPerson[person.name] = taken;
    if (taken < count) starved.push({ name: person.name, wanted: count - taken, scope: person.scope });
  }

  return { rows, perPerson, starved, unreachableSkipped };
}

/**
 * Both lists narrowed to what they share.
 *
 * An empty policy list means "no restriction", so it yields to the person's
 * scope; an empty intersection is left empty deliberately, which returns nothing
 * and is then reported as starvation rather than silently widened.
 */
function intersect(policy: string[] | undefined, scope: string[]): string[] {
  if (!policy?.length) return scope;
  return policy.filter((v) => scope.includes(v));
}
