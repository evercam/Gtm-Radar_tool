import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import {
  isLeadStatus,
  JOURNEY_STAGES,
  STATUS_JOURNEY_STAGE,
  type JourneyStage,
} from '@/lib/lifecycle';

/**
 * KPI aggregation.
 *
 * Everything is derived from the leads themselves rather than from counters,
 * so the numbers cannot drift out of step with reality after a reassignment,
 * a manual status change or a re-scoring pass.
 *
 * Reads page through the table because PostgREST caps a response at 1000 rows;
 * the alternative — a database view — would need its own migration and would
 * still have to be kept in step with the lifecycle vocabulary.
 */

export interface KpiWindow {
  /** Days back from now. */
  days: number;
  /**
   * Restrict to one owner's leads.
   *
   * A seller holds `kpi.view` but not `kpi.view.team`, so their Dashboard must
   * show their own performance rather than the whole company's — without this
   * the summary would quietly leak team-wide numbers to everyone.
   */
  ownerId?: string;
}

export interface FunnelStage {
  status: string;
  /** Records sitting at this status right now. */
  count: number;
  /** Records that have ever reached this stage — the funnel number. */
  reached: number;
}

export interface KpiSummary {
  total: number;
  funnel: FunnelStage[];

  enrichment: {
    attempted: number;
    succeeded: number;
    withContact: number;
    successRate: number;
  };

  sla: {
    tracked: number;
    breached: number;
    met: number;
    breachRate: number;
    medianHoursToContact: number | null;
  };

  conversion: {
    assigned: number;
    contacted: number;
    converted: number;
    lost: number;
    contactRate: number;
    conversionRate: number;
  };

  export: {
    eligible: number;
    exported: number;
    failed: number;
  };

  byBu: { bu: string; total: number; enriched: number; assigned: number; converted: number }[];
  byOwner: { ownerId: string; total: number; contacted: number; converted: number; breached: number }[];
  bySource: { source: string; total: number; enriched: number; converted: number }[];

  tableMissing: boolean;
}

const EMPTY: KpiSummary = {
  total: 0,
  funnel: [],
  enrichment: { attempted: 0, succeeded: 0, withContact: 0, successRate: 0 },
  sla: { tracked: 0, breached: 0, met: 0, breachRate: 0, medianHoursToContact: null },
  conversion: { assigned: 0, contacted: 0, converted: 0, lost: 0, contactRate: 0, conversionRate: 0 },
  export: { eligible: 0, exported: 0, failed: 0 },
  byBu: [],
  byOwner: [],
  bySource: [],
  tableMissing: false,
};

const rate = (numerator: number, denominator: number): number =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;

/** Median rather than mean — one stale lead shouldn't move the headline. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10
    : Math.round(sorted[mid] * 10) / 10;
}

const COLUMNS =
  // `assignee_id` as well as `owner_user_id`: the assignment pass always writes
  // the roster id and writes the app-account id only when that roster member
  // happens to have an account. Counting ownership by the account column alone
  // made 3 of 4 assigned leads invisible here — see `isAssigned` below.
  'id, status, bu, source_key, owner_user_id, assignee_id, contact_status, contact_email, enriched_at, ' +
  'last_enrichment_attempt, sla_due_at, sla_breached, owner_assigned_at, first_contact_at, ' +
  'apollo_exported_at, apollo_export_status, email_verified, created_at, ' +
  'queued_at, enrichment_started_at, prepared_at, call_prep_generated_at, contacted_at, ' +
  'converted_at, lost_at';

/**
 * Raised by a slice so one failed read fails the whole summary.
 *
 * Necessary because the slices run under Promise.all: returning a partial result
 * from a failed slice would produce a summary that is quietly missing a sixteenth
 * of the book, which is precisely the class of bug the ORDER BY note in
 * getKpiSummary describes. Better to report nothing than a confident undercount.
 */
class KpiReadError extends Error {}

/**
 * Sixteen disjoint, exhaustive slices of the uuid space.
 *
 * The correctness argument, because it is the whole basis for reading in parallel:
 * every uuid begins with one of the sixteen hex digits, each slice covers exactly
 * one of them, so every row falls in exactly one slice. Bounds are `id > from` and
 * `id <= to` — half-open on the low side so a boundary id belongs to one slice and
 * not two. The first slice has an empty `from` (no lower bound) and the last has an
 * empty `to` (no upper bound), so nothing at either end escapes.
 *
 * Sixteen because v4 uuids are uniform, which puts ~6,850 of 109,552 rows in each —
 * about seven pages, walked concurrently instead of 110 pages walked in series. An
 * uneven distribution would only unbalance the slices, never lose a row: coverage
 * comes from the bounds, not from the assumption.
 */
const SLICES: { from: string; to: string }[] = Array.from({ length: 16 }, (_, i) => {
  const boundary = (n: number) => `${n.toString(16)}0000000-0000-0000-0000-000000000000`;
  return {
    from: i === 0 ? '' : boundary(i),
    to: i === 15 ? '' : boundary(i + 1),
  };
});

/**
 * How many slices are read at once. MEASURED, not chosen.
 *
 * All sixteen at once saturates the database and individual queries start
 * exceeding the 8-second statement timeout about four pages deep:
 *
 *   16 concurrent   52.3 s   4 of 16 slices failed,  98,002 of 109,552 rows
 *    6 concurrent   30.1 s   0 failed,              109,552 rows
 *    4 concurrent   37.8 s   0 failed,              109,552 rows
 *    1 (sequential) 101.6 s  0 failed,              109,552 rows
 *
 * Six, then. The failures at sixteen are the important row of that table: a
 * timeout throws, and a thrown read empties the whole summary, so being greedy
 * here does not trade speed for accuracy — it trades a slow dashboard for a blank
 * one.
 */
const SLICE_CONCURRENCY = 6;

/**
 * True for the errors worth trying again.
 *
 * A statement timeout under concurrent load is transient by definition: the same
 * query on a quieter database succeeds, which is exactly what the numbers above
 * show. Anything else — a missing table, a bad column — will fail identically on a
 * second attempt, and retrying it would only double the wait before reporting it.
 */
const isTransient = (message: string) => /statement timeout|canceling statement|57014|timeout/i.test(message);

const stageIndex = (stage: JourneyStage): number => JOURNEY_STAGES.indexOf(stage);

/**
 * Where a record stands right now, or 'LOST'.
 *
 * The export check comes first because it outranks `status`: an exported lead
 * still reads ASSIGNED in the status column, but it has been handed over and
 * archived, so counting it as work sitting in somebody's queue overstates the
 * live pipeline by exactly the number of leads already shipped.
 */
function currentStage(r: Record<string, unknown>, status: string): JourneyStage | 'LOST' {
  if (r.apollo_exported_at) return 'EXPORTED';
  return isLeadStatus(status) ? STATUS_JOURNEY_STAGE[status] : 'RAW';
}

/**
 * How far a record has ever got, as a `JOURNEY_STAGES` index.
 *
 * Its position now is not the answer, for two reasons. A record moves forward,
 * so an ASSIGNED lead has certainly been enriched even though nothing currently
 * sits at ENRICHED — reading occupancy as a funnel produced the nonsense of
 * "Enriched 0" above "Assigned 3". And a record can leave the path entirely: a
 * LOST lead has no position on it at all, yet the stages it passed through
 * before dying are exactly what a funnel is measuring.
 *
 * So take the furthest of two kinds of evidence: where the record stands, and
 * every transition timestamp it carries. The timestamps are the only witness
 * for a record since lost, or re-queued after a failed enrichment pass.
 */
function furthestStage(r: Record<string, unknown>, position: JourneyStage | 'LOST'): number {
  const stamped = (...columns: string[]) => columns.some((c) => Boolean(r[c]));

  // Everything in the table was ingested, so RAW is always reached.
  let reached = 0;
  const at = (stage: JourneyStage, evidence: boolean) => {
    if (evidence) reached = Math.max(reached, stageIndex(stage));
  };

  // LOST is off the path, so it contributes nothing here and leans entirely on
  // the timestamps below to say how far the record had got before it died.
  if (position !== 'LOST') at(position, true);

  at('PENDING_ENRICHMENT', stamped('queued_at'));
  // `last_enrichment_attempt` counts: a worker held the record to attempt it.
  at('ENRICHING', stamped('enrichment_started_at', 'last_enrichment_attempt'));
  at('ENRICHED', stamped('enriched_at'));
  at('PREPARED', stamped('prepared_at', 'call_prep_generated_at'));
  // assignmentStore can set an owner without a status transition, so the
  // column itself is evidence — not just the stamp.
  at('ASSIGNED', stamped('owner_assigned_at', 'owner_user_id', 'contacted_at', 'first_contact_at', 'converted_at'));
  at('EXPORTED', stamped('apollo_exported_at'));

  return reached;
}

export async function getKpiSummary(window: KpiWindow = { days: 30 }): Promise<KpiSummary> {
  if (!isSupabaseServiceConfigured()) return EMPTY;

  const since = new Date(Date.now() - window.days * 86_400_000).toISOString();

  try {
    const service = getServiceSupabase();

    /*
      Keyset pagination, walked in PARALLEL over disjoint slices of the id space.

      An index would not have helped: `created_at >= 30 days ago` matches all
      109,552 rows, so the predicate has no selectivity and there is nothing to
      narrow. Offset paging was the first fault and keyset fixed it — page 1 took
      1.4 s and page 40 timed out at 8.3 s under `.range()`, because that asks
      Postgres to produce and discard the first 40,000 rows every time, while
      `id > last` costs the same at any depth.

      What remained was that keyset is inherently SEQUENTIAL: each page needs the
      previous page's last id, so 110 pages meant 110 round trips one after
      another. Measured at 92.7 s and 101.6 s for a 30-day window — and the KPI row
      sits at the top of the dashboard, so that is what somebody stares at.

      The fix is to make the walk parallel without making it wrong. Every row still
      arrives exactly once, because the slices are disjoint and exhaustive by
      construction — see SLICES — and each slice is walked by keyset within itself.
      Nothing about the aggregation below changed.

      Deliberately NOT rewritten as a SQL aggregate, though that is what fixed the
      dashboard rollups. The arithmetic under this loop derives a funnel position, a
      furthest-stage-reached fan-out, an SLA breach against wall-clock now, contact
      latency percentiles and three separate breakdowns — several hundred lines
      whose failure mode is a plausible wrong number, not an error. This file
      already carries the scar of exactly that (see the ORDER BY note below: every
      KPI was silently a random 72% sample). Reading the same rows faster risks
      nothing; recomputing them in SQL risks everything, for a further ~10 s.
    */
    /** Reads one page, retrying once if the database was merely busy. */
    const readPage = async (after: string, to: string) => {
      for (let attempt = 0; ; attempt += 1) {
        let q = service.from('canonical_projects').select(COLUMNS).gte('created_at', since);
        if (window.ownerId) q = q.eq('owner_user_id', window.ownerId);
        // `gt` on the low bound rather than `gte`, so the boundary id belongs to
        // exactly one slice and cannot be counted twice.
        if (after) q = q.gt('id', after);
        if (to) q = q.lte('id', to);

        // ORDER BY is load-bearing. Each request is a separate query, and
        // without a total order Postgres may return rows in a different order
        // each time, so the same row lands in two pages while another lands in
        // none. Measured on 44,191 records: 12,535 missed and 12,535 counted
        // twice — every KPI on the dashboard was a random 72% sample, which is
        // why the funnel could report 0 exports while two leads were exported.
        const { data, error } = await q.order('id', { ascending: true }).limit(1000);

        if (!error) return (data ?? []) as unknown as Record<string, unknown>[];
        // One retry, and only for a timeout. Anything else fails the same way twice.
        if (attempt >= 1 || !isTransient(error.message)) throw new KpiReadError(error.message);
      }
    };

    const walkSlice = async (slice: { from: string; to: string }) => {
      const rows: Record<string, unknown>[] = [];
      let after = slice.from;
      // Generous: a slice holds ~1/16th of the table, so ~7 pages. A runaway guard,
      // not a limit anyone should reach.
      for (let guard = 0; guard < 200; guard += 1) {
        const page = await readPage(after, slice.to);
        if (page.length === 0) break;
        rows.push(...page);
        // Advance the cursor, or the next request returns this same page forever.
        after = String(page[page.length - 1].id);
        if (page.length < 1000) break;
      }
      return rows;
    };

    /*
      A fixed pool rather than Promise.all over all sixteen: the concurrency is the
      whole point of the measurement above, and mapping every slice at once is what
      produced the timeouts. Workers pull the next slice as they finish, so six
      requests are in flight and no more.
    */
    const pages: Record<string, unknown>[][] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: SLICE_CONCURRENCY }, async () => {
        while (next < SLICES.length) {
          const index = next;
          next += 1;
          pages[index] = await walkSlice(SLICES[index]);
        }
      })
    );

    /*
      Order across slices is irrelevant: every consumer below is a counter, a map
      or a push onto hoursToContact, which is reduced to percentiles. There is no
      position-dependent logic to preserve.
    */
    const rows = pages.flat();

    /** Where records stand now — one bucket per journey stage, plus LOST. */
    const funnelCounts = new Map<string, number>();
    /** One slot per stage; a record increments every stage it ever reached. */
    const reachedCounts = new Array<number>(JOURNEY_STAGES.length).fill(0);
    const buMap = new Map<string, { total: number; enriched: number; assigned: number; converted: number }>();
    const ownerMap = new Map<string, { total: number; contacted: number; converted: number; breached: number }>();
    const sourceMap = new Map<string, { total: number; enriched: number; converted: number }>();
    const hoursToContact: number[] = [];

    let attempted = 0;
    let enrichSucceeded = 0;
    let withContact = 0;
    let slaTracked = 0;
    let slaBreached = 0;
    let assigned = 0;
    let contacted = 0;
    let converted = 0;
    let lost = 0;
    let exportEligible = 0;
    let exported = 0;
    let exportFailed = 0;

    const now = Date.now();

    for (const r of rows) {
      const status = (r.status as string) ?? 'RAW';

      const position = currentStage(r, status);
      funnelCounts.set(position, (funnelCounts.get(position) ?? 0) + 1);

      // Cumulative: reaching ASSIGNED means having reached everything before it.
      const furthest = furthestStage(r, position);
      for (let i = 0; i <= furthest; i += 1) reachedCounts[i] += 1;

      const bu = (r.bu as string) ?? 'unknown';
      const source = (r.source_key as string) ?? 'unknown';
      // Two different questions, and conflating them broke the handover rate.
      //
      // `owner` is an APP ACCOUNT, used only for the per-owner breakdown, which
      // has to resolve to a user profile to show a name.
      //
      // `isAssigned` is whether anybody is working the lead at all. The
      // assignment pass writes `assignee_id` for every assignment and
      // `owner_user_id` only when that roster member also has an app account —
      // so counting by the account column reported 1 assigned lead out of 4, and
      // the handover rate came out as 2 exported / 1 assigned = 200%.
      //
      // The export itself requires `assignee_id`, so counting it this way also
      // makes the exported set a genuine subset of the assigned set, which is
      // what keeps the rate at or below 100% by construction rather than by
      // clamping it afterwards.
      const owner = r.owner_user_id as string | null;
      const isAssigned = Boolean(r.assignee_id ?? r.owner_user_id);
      const isEnriched = Boolean(r.enriched_at);
      const isConverted = status === 'CONVERTED';

      if (r.last_enrichment_attempt) attempted += 1;
      if (isEnriched) enrichSucceeded += 1;
      if (r.contact_status === 'has_contact') withContact += 1;

      if (r.sla_due_at) {
        slaTracked += 1;
        // Breached if flagged, or if the deadline simply passed with no contact.
        const due = new Date(r.sla_due_at as string).getTime();
        const missed = r.first_contact_at ? new Date(r.first_contact_at as string).getTime() > due : due < now;
        if (r.sla_breached || missed) slaBreached += 1;
      }

      if (r.owner_assigned_at && r.first_contact_at) {
        const hrs =
          (new Date(r.first_contact_at as string).getTime() - new Date(r.owner_assigned_at as string).getTime()) /
          3_600_000;
        if (Number.isFinite(hrs) && hrs >= 0) hoursToContact.push(hrs);
      }

      if (isAssigned) assigned += 1;
      if (r.first_contact_at || status === 'CONTACTED') contacted += 1;
      if (isConverted) converted += 1;
      if (status === 'LOST') lost += 1;

      if (isAssigned && r.email_verified) exportEligible += 1;
      if (r.apollo_exported_at) exported += 1;
      if (r.apollo_export_status === 'failed') exportFailed += 1;

      const b = buMap.get(bu) ?? { total: 0, enriched: 0, assigned: 0, converted: 0 };
      b.total += 1;
      if (isEnriched) b.enriched += 1;
      if (isAssigned) b.assigned += 1;
      if (isConverted) b.converted += 1;
      buMap.set(bu, b);

      const s = sourceMap.get(source) ?? { total: 0, enriched: 0, converted: 0 };
      s.total += 1;
      if (isEnriched) s.enriched += 1;
      if (isConverted) s.converted += 1;
      sourceMap.set(source, s);

      if (owner) {
        const o = ownerMap.get(owner) ?? { total: 0, contacted: 0, converted: 0, breached: 0 };
        o.total += 1;
        if (r.first_contact_at) o.contacted += 1;
        if (isConverted) o.converted += 1;
        if (r.sla_breached) o.breached += 1;
        ownerMap.set(owner, o);
      }
    }

    // LOST is off the path, so it has no cumulative figure of its own — the
    // stages it passed through are already counted in `reached` above it.
    const funnel: FunnelStage[] = [
      ...JOURNEY_STAGES.map((status, i) => ({
        status,
        count: funnelCounts.get(status) ?? 0,
        reached: reachedCounts[i],
      })),
      { status: 'LOST', count: funnelCounts.get('LOST') ?? 0, reached: funnelCounts.get('LOST') ?? 0 },
    ];

    return {
      total: rows.length,
      funnel,
      enrichment: {
        attempted,
        succeeded: enrichSucceeded,
        withContact,
        successRate: rate(enrichSucceeded, attempted),
      },
      sla: {
        tracked: slaTracked,
        breached: slaBreached,
        met: slaTracked - slaBreached,
        breachRate: rate(slaBreached, slaTracked),
        medianHoursToContact: median(hoursToContact),
      },
      conversion: {
        assigned,
        contacted,
        converted,
        lost,
        contactRate: rate(contacted, assigned),
        conversionRate: rate(converted, contacted),
      },
      export: { eligible: exportEligible, exported, failed: exportFailed },
      byBu: Array.from(buMap.entries())
        .map(([bu, v]) => ({ bu, ...v }))
        .sort((a, b) => b.total - a.total),
      byOwner: Array.from(ownerMap.entries())
        .map(([ownerId, v]) => ({ ownerId, ...v }))
        .sort((a, b) => b.total - a.total),
      bySource: Array.from(sourceMap.entries())
        .map(([source, v]) => ({ source, ...v }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 15),
      tableMissing: false,
    };
  } catch (err) {
    /*
      A read failure is only `tableMissing` when the message says so.

      This distinction was previously made at the call site, where the query error
      was inspected directly; slices throw now, so it has to be made here instead.
      Losing it would report a statement timeout as a missing migration, and the
      dashboard renders a "run the migration" notice for that — sending somebody to
      the SQL editor to fix a table that is present and fine.
    */
    if (err instanceof KpiReadError) {
      return { ...EMPTY, tableMissing: /does not exist|schema cache/i.test(err.message) };
    }
    return { ...EMPTY, tableMissing: true };
  }
}

/** Flattens the summary to CSV for the export button. */
export function kpiToCsv(summary: KpiSummary): string {
  const lines: string[] = ['section,key,value'];
  const push = (section: string, key: string, value: string | number) =>
    lines.push(`${section},"${String(key).replace(/"/g, '""')}",${value}`);

  push('overview', 'total_records', summary.total);
  // Both figures, because "funnel,ASSIGNED,3" alone never said which it meant.
  for (const f of summary.funnel) push('funnel_reached', f.status, f.reached);
  for (const f of summary.funnel) push('funnel_current', f.status, f.count);

  push('enrichment', 'attempted', summary.enrichment.attempted);
  push('enrichment', 'succeeded', summary.enrichment.succeeded);
  push('enrichment', 'success_rate_pct', summary.enrichment.successRate);
  push('enrichment', 'with_contact', summary.enrichment.withContact);

  push('sla', 'tracked', summary.sla.tracked);
  push('sla', 'breached', summary.sla.breached);
  push('sla', 'breach_rate_pct', summary.sla.breachRate);
  push('sla', 'median_hours_to_contact', summary.sla.medianHoursToContact ?? '');

  push('conversion', 'assigned', summary.conversion.assigned);
  push('conversion', 'contacted', summary.conversion.contacted);
  push('conversion', 'converted', summary.conversion.converted);
  push('conversion', 'contact_rate_pct', summary.conversion.contactRate);
  push('conversion', 'conversion_rate_pct', summary.conversion.conversionRate);

  push('export', 'eligible', summary.export.eligible);
  push('export', 'exported', summary.export.exported);
  push('export', 'failed', summary.export.failed);

  for (const b of summary.byBu) push('by_bu', b.bu, b.total);
  for (const s of summary.bySource) push('by_source', s.source, s.total);

  return lines.join('\n');
}
