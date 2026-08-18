import { getReadSupabase, getServiceSupabase } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CanonicalProjectRow } from '@/lib/supabase/types';
import { DEFAULT_RULES, route as routeRecord, type RoutingRule, type RoutableRecord } from '@/lib/routing';
import { scorePriority, DEFAULT_PRIORITY_CONFIG, type PriorityConfig, type PriorityVerdict } from '@/lib/priority';
import { configForBu, getEnrichmentPolicy, type ScoringPolicySet } from '@/lib/policies';
import { recordReachable } from '@/lib/export/reachability';
import { planSupply, adviseRebalance, type SupplyPlan, type RebalanceAdvice } from '@/lib/supply';
import { getDemandPlan } from '@/lib/enrich/demand';
import { isColdArrival, arrivalFor, compareArrival } from '@/lib/arrival';
import { PRIORITY_BANDS, ROUTES, STAGES } from '@/lib/semantics';
import { COMPLETENESS_TIER_RANGES } from '@/lib/completeness';
import { logEventAsync } from '@/lib/observability/events';

/** A–E, taken from the tier ranges so the two cannot drift apart. */
const COMPLETENESS_TIERS = COMPLETENESS_TIER_RANGES.map((r) => r.code);

// ============================================================================
// canonical_projects
// ============================================================================

export async function getRecentCanonicalProjects(limit = 25): Promise<CanonicalProjectRow[]> {
  const supabase = await getReadSupabase();
  const { data, error } = await supabase
    .from('canonical_projects')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    /*
      Logged, not silent. The comment here used to read "table not created yet",
      but this branch catches EVERY error including a statement timeout, and an
      empty dashboard list is indistinguishable from a quiet day. Display-only, so
      it still degrades rather than failing the page — it just leaves a trace.
    */
    console.error(`getRecentCanonicalProjects: ${error.message}`);
    return [];
  }
  return (data ?? []) as CanonicalProjectRow[];
}

/**
 * One record, with everything on it — what the record drawer shows.
 *
 * `select('*')` rather than a column list on purpose: this is the one read that
 * wants every field the schema happens to have, and asking for named columns
 * would make it fail on exactly the half-migrated databases the tiered
 * degradation in `getRecords` exists to tolerate.
 *
 * Returns null for a missing id, an unreadable row, or a row RLS does not grant
 * the caller — the drawer renders "not found" for all three, which is the
 * correct answer to give a user in each case.
 */
export async function getRecordDetail(id: string): Promise<CanonicalProjectRow | null> {
  const supabase = await getReadSupabase();
  try {
    const { data, error } = await supabase.from('canonical_projects').select('*').eq('id', id).maybeSingle();
    if (error) return null;
    return (data as CanonicalProjectRow) ?? null;
  } catch {
    return null;
  }
}

/** One row per (BU, vertical, contact_status) with a count — the pipeline rollup. */
export interface PipelineRollupRow {
  bu: string;
  vertical: string;
  contact_status: string;
  count: number;
}

/**
 * True when a Postgres error is "that column doesn't exist" (42703) — i.e. the
 * priority migration hasn't been run on this database yet. Every read that
 * touches the new columns falls back rather than returning an empty table,
 * because an un-migrated install must keep working exactly as it did before.
 */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42703' || /does not exist|schema cache/i.test(error.message ?? '');
}

/** Whether the priority columns exist — drives the "run the migration" notice. */
export async function hasPriorityColumns(): Promise<boolean> {
  try {
    const supabase = await getReadSupabase();
    const { error } = await supabase.from('canonical_projects').select('priority_score').limit(1);
    return !isMissingColumn(error);
  } catch {
    return false;
  }
}

/**
 * Columns the scoring + routing pass needs. Kept in one place because the
 * dry-run preview and the materialized pass must read exactly the same fields
 * — if they diverge, the preview stops predicting the write.
 */
const SCORING_COLUMNS =
  'id, bu, icp_code, vertical, record_type, contact_status, population_percentage, country, account_key, ' +
  'current_phase, estimated_value, estimated_value_currency, capacity_mw, contact_name, contact_email, contact_phone, ' +
  'bid_date, construction_start_date, announced_date, created_at';

interface AccountSignal {
  key_account: boolean;
  key_account_score: number | null;
}

/**
 * Key-account flags per account_key — the account-level half of both passes.
 *
 * `partial` is the important half of the return. This walk feeds SCORING: a missing
 * account_key does not read as "no flags on file", it reads as "not a key account",
 * so a truncated read silently scores part of the book as though those accounts were
 * ordinary. Nothing downstream could tell, because the map has no way to say which
 * keys it never managed to load.
 *
 * It used to `break` on error and return whatever it had. Keyset-paged now for the
 * same reason `rerouteAll` is — offset paging gets slower with depth until it
 * exceeds the statement timeout, which is precisely how that pass came to abandon
 * 613 records while reporting success.
 */
async function loadAccountSignals(
  client: SupabaseClient
): Promise<{ signals: Map<string, AccountSignal>; partial: string | null }> {
  const map = new Map<string, AccountSignal>();
  const PAGE = 1000;
  let after = '';

  for (let guard = 0; guard < 500; guard += 1) {
    // The ORDER BY is load-bearing twice over: it makes the page boundary stable,
    // and it is what `gt(account_key, after)` resumes from.
    let q = client
      .from('account_enrichment')
      .select('account_key, key_account, key_account_score')
      .order('account_key', { ascending: true })
      .limit(PAGE);
    if (after) q = q.gt('account_key', after);

    const { data, error } = await q;
    if (error) return { signals: map, partial: error.message };
    const batch = (data ?? []) as ({ account_key: string } & AccountSignal)[];
    if (batch.length === 0) break;
    for (const r of batch) map.set(r.account_key, r);
    after = String(batch[batch.length - 1].account_key);
    if (batch.length < PAGE) break;
  }
  return { signals: map, partial: null };
}

/** Score a raw row, then build the RoutableRecord the rules evaluate. */
function toScoredRecord(
  r: Record<string, unknown>,
  signals: Map<string, AccountSignal>,
  scoring: PriorityConfig | ScoringPolicySet,
  now: number
): { record: RoutableRecord; priority: PriorityVerdict } {
  // A business unit may weight the components differently, so each record is
  // scored with its own BU's config. Passing a bare config still works — the
  // dry-run preview and the search route score against one policy.
  const config = 'byBu' in scoring ? configForBu(scoring, (r.bu as string) ?? null) : scoring;
  const a = (typeof r.account_key === 'string' ? signals.get(r.account_key) : undefined) ?? {
    key_account: false,
    key_account_score: null,
  };
  const priority = scorePriority(
    {
      icp_code: (r.icp_code as string) ?? null,
      record_type: (r.record_type as string) ?? null,
      vertical: (r.vertical as string) ?? null,
      current_phase: (r.current_phase as string) ?? null,
      estimated_value: (r.estimated_value as number) ?? null,
      estimated_value_currency: (r.estimated_value_currency as string) ?? null,
      capacity_mw: (r.capacity_mw as number) ?? null,
      contact_name: (r.contact_name as string) ?? null,
      contact_email: (r.contact_email as string) ?? null,
      contact_phone: (r.contact_phone as string) ?? null,
      contact_status: (r.contact_status as string) ?? null,
      population_percentage: (r.population_percentage as number) ?? null,
      bid_date: (r.bid_date as string) ?? null,
      construction_start_date: (r.construction_start_date as string) ?? null,
      announced_date: (r.announced_date as string) ?? null,
      created_at: (r.created_at as string) ?? null,
      key_account: a.key_account,
      key_account_score: a.key_account_score,
    },
    config,
    now
  );
  return {
    priority,
    record: {
      bu: (r.bu as string) ?? null,
      icp_code: (r.icp_code as string) ?? null,
      vertical: (r.vertical as string) ?? null,
      record_type: (r.record_type as string) ?? null,
      contact_status: (r.contact_status as string) ?? null,
      population_percentage: (r.population_percentage as number) ?? null,
      country: (r.country as string) ?? null,
      key_account: Boolean(a.key_account),
      key_account_score: a.key_account_score ?? null,
      priority_score: priority.score,
      priority_band: priority.band,
    },
  };
}

/** Current routing rules from the DB, or the built-in defaults if none saved. */
export async function getRoutingPolicy(): Promise<{ rules: RoutingRule[]; isDefault: boolean }> {
  // Service role, unlike everything else in this file. routing_policy is
  // configuration — one row, readable by any signed-in user — and it only
  // lives here for historical reasons. Read through the session client it
  // returned the BUILT-IN defaults instead of the saved rules, which looks
  // identical to "nobody has configured routing yet".
  const supabase = getServiceSupabase();
  try {
    const { data, error } = await supabase.from('routing_policy').select('rules').eq('id', 'default').maybeSingle();
    if (error || !data || !Array.isArray(data.rules) || data.rules.length === 0)
      return { rules: DEFAULT_RULES, isDefault: true };
    return { rules: data.rules as RoutingRule[], isDefault: false };
  } catch {
    return { rules: DEFAULT_RULES, isDefault: true };
  }
}

/**
 * Ids per UPDATE. A UUID is ~39 characters once quoted and comma-separated in
 * the query string, so 200 keeps the URL under 8KB — comfortably inside what
 * proxies and PostgREST accept.
 */
const UPDATE_BATCH = 200;

/**
 * Score AND route every record, writing both results.
 *
 * The two run in one pass because routing rules can match on priority — score
 * first, then lane, in the same read. Records are grouped by their full
 * outcome signature so the whole table updates in a handful of statements
 * rather than one per row.
 */
/**
 * How much of the table a scoring pass covers.
 *
 *   'unscored'  only records that have never been scored (`scored_at is null`).
 *               What a daily run wants: bounded by what arrived since the last
 *               one, so it finishes in seconds instead of ten minutes.
 *   'all'       every record. Needed when the POLICY changes — new weights or
 *               band cut-offs make every existing score wrong, and only a full
 *               pass fixes that.
 *
 * The distinction matters because a full pass over 22,000 records takes 8–10
 * minutes, against a 300-second function limit: as the only option it could not
 * run in production at all, so new records were never scored and never reached a
 * seller.
 */
export type ScoringScope = 'unscored' | 'all';

export async function rerouteAll(
  rules: RoutingRule[],
  scoringConfig: PriorityConfig | ScoringPolicySet = DEFAULT_PRIORITY_CONFIG,
  opts: { scope?: ScoringScope; maxRecords?: number } = {}
): Promise<{
  total: number;
  byLane: Record<string, number>;
  byBand: Record<string, number>;
  scope: ScoringScope;
  reachedCap: boolean;
  /**
   * Set when the walk stopped on a database error rather than finishing.
   *
   * `reachedCap` already covers the deliberate stop. This covers the accidental
   * one, which previously looked identical to success: `total` reported what was
   * scored and nothing said the rest had been abandoned. A partial pass that calls
   * itself complete is how the unscored backlog grew every night.
   */
  truncated: string | null;
}> {
  const scope = opts.scope ?? 'unscored';
  const maxRecords = opts.maxRecords ?? Infinity;
  const service = getServiceSupabase();
  /*
    REFUSE TO SCORE on a partial signal read.

    A missing account_key does not read as "unknown", it reads as "not a key
    account" — so scoring the book against half the flags writes wrong bands and
    wrong lanes to the database, and the next run sees `scored_at` set and skips
    them. The damage would outlive the failure that caused it, which is why this is
    the one place that aborts rather than degrading.
  */
  const { signals, partial: signalsPartial } = await loadAccountSignals(service);
  if (signalsPartial) {
    return {
      total: 0,
      byLane: {},
      byBand: {},
      scope,
      reachedCap: false,
      truncated: `key-account signals could not be fully read (${signalsPartial}) — refusing to score against partial flags, because a missing account reads as "not a key account" and the wrong band would be written and then marked done.`,
    };
  }
  const nowMs = Date.now();

  // group record ids by outcome signature (disposition + priority)
  const groups = new Map<string, string[]>();
  const byLane: Record<string, number> = {};
  const byBand: Record<string, number> = {};
  let total = 0;

  /*
    KEYSET paging on `id`, not `.range()`.

    Offset paging re-walks everything it has already skipped, so a deep page pays
    for every row before it — and past a certain depth it simply exceeds the
    statement timeout. Observed 2026-08-13 on a real run: 19,613 records were
    unscored, the pass reported `total: 19000` and `reachedCap: false`, and 613
    records were left. 19,000 is exactly nineteen pages, so page twenty — offset
    19,000 — timed out, hit the `if (error) break` below, and the run reported
    success having silently abandoned its tail.

    THAT IS WHY THE BACKLOG EXISTED. A nightly cron that drops its last page and
    calls itself done accumulates a remainder forever, and the remainder was the
    newest sources: the interconnection queues sat at 0.8% scored, which made the
    earliest signals this tool has invisible to the enrichment queue.

    `id > last` costs the same on every page. The ORDER BY was already here and is
    what makes it safe — this only stops paying the offset. `readyInventory` in
    lib/enrich/demand.ts does the same thing for the same reason.
  */
  let after = '';
  let truncated: string | null = null;

  for (let guard = 0; guard < 2000; guard += 1) {
    // ORDER BY is not decoration here. Without a stable total order a page
    // boundary repeats and skips rows. That is why a pass reporting "22,438
    // records" left 8,555 with a null band: it counted rows READ, duplicates
    // included, not distinct rows covered. `id` is unique and indexed, which is
    // all a keyset-stable page needs.
    let page = service
      .from('canonical_projects')
      .select(SCORING_COLUMNS)
      .order('id', { ascending: true })
      .limit(1000);
    // Unscored-only reads shrink as the backlog clears, so a daily run costs
    // roughly what arrived that day.
    if (scope === 'unscored') page = page.is('scored_at', null);
    if (after) page = page.gt('id', after);

    const { data, error } = await page;
    /*
      Record WHY the walk stopped instead of returning as though it finished.

      This was a bare `break`, which is what let a timeout masquerade as a
      completed pass. The caller now gets the message and can say the run was
      partial — see `truncated` in the return.
    */
    if (error) {
      truncated = error.message;
      break;
    }
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    // Advance the cursor before the loop below, which can `break` on the record
    // cap — the next page must resume from the last row READ, not the last scored.
    if (batch.length > 0) after = String(batch[batch.length - 1].id);
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
      const { record, priority } = toScoredRecord(r, signals, scoringConfig, nowMs);
      const d = routeRecord(record, rules);
      const sig = JSON.stringify([
        d.route,
        d.stage,
        d.team ?? '',
        d.reason,
        priority.score,
        priority.band,
        priority.reasons,
      ]);
      const bucket = groups.get(sig);
      if (bucket) bucket.push(r.id as string);
      else groups.set(sig, [r.id as string]);

      const lane = `${d.route}/${d.stage}`;
      byLane[lane] = (byLane[lane] ?? 0) + 1;
      byBand[priority.band] = (byBand[priority.band] ?? 0) + 1;
      total += 1;
      if (total >= maxRecords) break;
    }
    if (!data || data.length < 1000 || total >= maxRecords) break;
  }

  // batch-update each group (identical outcome) by id list
  const now = new Date().toISOString();
  for (const [sig, ids] of groups) {
    const [route, stage, team, reason, score, band, reasons] = JSON.parse(sig) as [
      string,
      string,
      string,
      string,
      number,
      string,
      string[],
    ];
    const patch = {
      route,
      stage,
      assigned_team: team || null,
      routing_reason: reason,
      routed_at: now,
      priority_score: score,
      priority_band: band,
      priority_reasons: reasons,
      scored_at: now,
    };
    // `.in()` goes into the query string, and a UUID costs ~39 characters
    // there. Batching a thousand of them built a ~39KB URL, which every proxy
    // in the path rejects as a 400 — so the whole materialize pass failed with
    // "Bad Request" and nothing was ever scored or routed.
    for (let i = 0; i < ids.length; i += UPDATE_BATCH) {
      const { error } = await service
        .from('canonical_projects')
        .update(patch)
        .in('id', ids.slice(i, i + UPDATE_BATCH));
      if (error) throw new Error(error.message);
    }
  }
  return { total, byLane, byBand, scope, reachedCap: total >= maxRecords, truncated };
}

export interface RoutingPreview {
  total: number;
  byLane: { route: string; stage: string; count: number }[];
  byRule: { rule: string; count: number }[];
  byBand: { band: string; count: number }[];
  /** Mean priority across all records — moves as the scoring policy is tuned. */
  avgPriority: number;
  /**
   * The values actually present in the data, collected during the same scan.
   * The rule builder offers these as choices so you can only match on things
   * that exist — a hardcoded country list would mostly offer dead ends.
   */
  facets: {
    bu: string[];
    icp: string[];
    vertical: string[];
    recordType: string[];
    country: string[];
  };
  /**
   * Why this preview is incomplete, when it is.
   *
   * The whole promise of this function is "what materializing would write", and a
   * scan that stopped early or scored against half the key-account flags breaks that
   * promise while still returning a full-looking set of tallies. It writes nothing,
   * so it may degrade — but somebody about to press the button on a real run has to
   * know the numbers under it are partial.
   */
  partial?: string | null;
}

/**
 * Dry-run: score and route every record and tally the split. No writes.
 * Uses the identical scoring + routing path as rerouteAll, so what the preview
 * shows is exactly what materializing would write.
 */
export async function getRoutingPreview(
  rules: RoutingRule[],
  scoringConfig: PriorityConfig | ScoringPolicySet = DEFAULT_PRIORITY_CONFIG
): Promise<RoutingPreview> {
  const empty: RoutingPreview = {
    total: 0,
    byLane: [],
    byRule: [],
    byBand: [],
    avgPriority: 0,
    facets: { bu: [], icp: [], vertical: [], recordType: [], country: [] },
  };
  const supabase = await getReadSupabase();
  try {
    const { signals, partial: signalsPartial } = await loadAccountSignals(supabase);
    let partial: string | null = signalsPartial
      ? `key-account flags are only partly loaded (${signalsPartial}), so the band split understates key accounts`
      : null;
    const nowMs = Date.now();

    const lane = new Map<string, number>();
    const rule = new Map<string, number>();
    const band = new Map<string, number>();
    const facet = {
      bu: new Set<string>(),
      icp: new Set<string>(),
      vertical: new Set<string>(),
      recordType: new Set<string>(),
      country: new Set<string>(),
    };
    let total = 0;
    let scoreSum = 0;

    for (let from = 0; from < 1_000_000; from += 1000) {
      const { data, error } = await supabase
        .from('canonical_projects')
        .select(SCORING_COLUMNS)
        // Ordered for the same reason as the scoring pass above: an unordered
        // `.range()` walk repeats rows and skips others, which here would make
        // the lane and band preview disagree with what the run actually does.
        .order('id', { ascending: true })
        .range(from, from + 999);
      /*
        Was `return empty` — a preview showing zeros of everything, which reads as
        "nothing would be routed" rather than "the scan failed". Keep what was
        counted and say it is incomplete.
      */
      if (error) {
        partial = `the scan stopped after ${total} records (${error.message})`;
        break;
      }
      for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
        const { record, priority } = toScoredRecord(r, signals, scoringConfig, nowMs);
        const d = routeRecord(record, rules);
        const key = `${d.route}/${d.stage}`;
        lane.set(key, (lane.get(key) ?? 0) + 1);
        rule.set(d.reason, (rule.get(d.reason) ?? 0) + 1);
        band.set(priority.band, (band.get(priority.band) ?? 0) + 1);
        if (record.bu) facet.bu.add(record.bu);
        if (record.icp_code) facet.icp.add(record.icp_code);
        if (record.vertical) facet.vertical.add(record.vertical);
        if (record.record_type) facet.recordType.add(record.record_type);
        if (record.country) facet.country.add(record.country);
        scoreSum += priority.score;
        total += 1;
      }
      if (!data || data.length < 1000) break;
    }

    const byLane = Array.from(lane.entries())
      .map(([k, count]) => ({ route: k.split('/')[0], stage: k.split('/')[1], count }))
      .sort((a, b) => b.count - a.count);
    const byRule = Array.from(rule.entries())
      .map(([r, count]) => ({ rule: r, count }))
      .sort((a, b) => b.count - a.count);
    const byBand = ['P1', 'P2', 'P3', 'P4'].map((b) => ({ band: b, count: band.get(b) ?? 0 }));
    const sorted = (s: Set<string>) => Array.from(s).sort((a, b) => a.localeCompare(b));
    return {
      total,
      byLane,
      byRule,
      byBand,
      avgPriority: total ? Math.round(scoreSum / total) : 0,
      facets: {
        bu: sorted(facet.bu),
        icp: sorted(facet.icp),
        vertical: sorted(facet.vertical),
        recordType: sorted(facet.recordType),
        country: sorted(facet.country),
      },
      partial,
    };
  } catch (err) {
    // `empty` alone would show a confident set of zeros. Name the cause.
    return { ...empty, partial: err instanceof Error ? err.message : String(err) };
  }
}

export interface RecordRow {
  id: string;
  canonical_name: string;
  source_key: string;
  record_type: string | null;
  bu: string | null;
  vertical: string | null;
  ref_code: string | null;
  contact_status: string | null;
  country: string | null;
  capacity_mw: number | null;
  estimated_value: number | null;
  population_percentage: number | null;
  account_key: string | null;
  route: string | null;
  stage: string | null;
  priority_score: number | null;
  priority_band: string | null;
  priority_reasons: string[] | null;
  status: string | null;
  owner_user_id: string | null;
  sla_due_at: string | null;
  sla_breached: boolean | null;
  call_prep_summary: string | null;
  owner_group_key: string | null;
  created_at: string;
  apollo_exported_at: string | null;
  apollo_export_status: string | null;
}
/**
 * `intent` ranks by readiness, `priority` by value.
 *
 * They are different questions and the top of one is not the top of the other: a
 * large owner scores well on priority whether or not anything is happening. A rep
 * working a priority list spends the morning on the biggest project; an intent list
 * gives them the readiest.
 */
export type RecordSort = 'priority' | 'intent' | 'newest' | 'value' | 'exported';
export interface RecordsQuery {
  page?: number;
  pageSize?: number;
  source?: string;
  bu?: string;
  vertical?: string;
  recordType?: string;
  contactStatus?: string;
  route?: string;
  stage?: string;
  band?: string;
  /** Completeness tier A–E as delivered by the source. */
  completenessTier?: string;
  status?: string;
  /** Restrict to one owner. 'me' is resolved by the caller to a user id. */
  ownerId?: string;
  /** Only leads with nobody assigned. */
  unassigned?: boolean;
  /** Every lead owned by one company — an `owner_group_key` value. */
  ownerGroup?: string;
  /**
   * Include leads already sent to Apollo.
   *
   * Off by default: once a lead has been handed over it is archived, and leaving
   * it in the working list makes the list lie about how much work is left. The
   * record is never deleted and stays reachable with `?archived=1` or by direct
   * link — archiving is about what the queue shows, not about losing anything.
   */
  includeExported?: boolean;
  search?: string;
  sort?: RecordSort;
}
export interface RecordsResult {
  rows: RecordRow[];
  total: number;
}

const RECORD_COLUMNS_CORE =
  'id,canonical_name,source_key,record_type,bu,vertical,ref_code,contact_status,country,capacity_mw,' +
  'estimated_value,population_percentage,account_key,created_at,' +
  // Arrival timing is derived from these on read. Cheap to carry, and it stops
  // the list disagreeing with the record drawer, which reads the row entire.
  // All five are base columns, present in every migration state, so they
  // belong in the CORE tier rather than a higher one.
  'current_phase,construction_start_date,estimated_completion_date,announced_date,bid_date,' +
  // The archive flag, also CORE because the archived filter below reads it at
  // every tier — a database missing the apollo_export migration could already
  // not run this query, so carrying the column costs no robustness. The list
  // needs the value and not just the predicate: a row that survives
  // `includeExported` has to be able to say when it was handed over.
  'apollo_exported_at,apollo_export_status';
const RECORD_COLUMNS_ROUTING = `${RECORD_COLUMNS_CORE},route,stage`;
const RECORD_COLUMNS_FULL =
  `${RECORD_COLUMNS_ROUTING},priority_score,priority_band,priority_reasons,status,` +
  'owner_user_id,sla_due_at,sla_breached,call_prep_summary,owner_group_key';

/** Which optional migrations a query may use. Degrades one tier at a time. */
type ColumnTier = 'full' | 'routing' | 'core';
const TIER_COLUMNS: Record<ColumnTier, string> = {
  full: RECORD_COLUMNS_FULL,
  routing: RECORD_COLUMNS_ROUTING,
  core: RECORD_COLUMNS_CORE,
};

/**
 * The unified table itself — every canonical_projects record, paginated +
 * filtered.
 *
 * Optional migrations are handled by degrading, not by failing: it asks for the
 * priority columns first, drops to routing-only if that migration is missing,
 * then to the core columns if routing is missing too. A database at any of the
 * three states renders a full table rather than a blank page.
 */
export async function getRecords(q: RecordsQuery = {}): Promise<RecordsResult> {
  const supabase = await getReadSupabase();
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, q.pageSize ?? 100));
  const from = (page - 1) * pageSize;

  const run = async (tier: ColumnTier, sortMode: RecordSort) => {
    const hasPriority = tier === 'full';
    const hasRouting = tier === 'full' || tier === 'routing';

    let query = supabase.from('canonical_projects').select(TIER_COLUMNS[tier], { count: 'exact' });
    // Archived unless asked for. See `includeExported`.
    if (!q.includeExported) query = query.is('apollo_exported_at', null);
    if (q.source) query = query.eq('source_key', q.source);
    if (q.bu) query = query.eq('bu', q.bu);
    if (q.vertical) query = query.eq('vertical', q.vertical);
    if (q.recordType) query = query.eq('record_type', q.recordType);
    if (q.contactStatus) query = query.eq('contact_status', q.contactStatus);
    if (q.completenessTier) query = query.eq('source_completeness_tier', q.completenessTier);
    if (hasRouting && q.route) query = query.eq('route', q.route);
    if (hasRouting && q.stage) query = query.eq('stage', q.stage);
    if (hasPriority && q.band) query = query.eq('priority_band', q.band);
    if (hasPriority && q.status) query = query.eq('status', q.status);
    if (hasPriority && q.ownerId) query = query.eq('owner_user_id', q.ownerId);
    if (hasPriority && q.unassigned) query = query.is('assignee_id', null);
    // Gated on the same tier flag as the column below, so a database without
    // the owner_group_key migration ignores the filter rather than erroring on
    // an unknown column — a stale bookmarked URL must not break the list.
    if (hasPriority && q.ownerGroup) query = query.eq('owner_group_key', q.ownerGroup);
    if (q.search?.trim()) query = query.ilike('canonical_name', `%${q.search.trim().replace(/[%_]/g, '')}%`);

    // Priority-first by default — the whole point of scoring is that the top of
    // the list is the work queue. Unscored records sort last, not first.
    /*
      Ascending, because intent_rank is 0-for-readiest. Tie-broken by priority, so
      within the same readiness the bigger project comes first — and the composite
      index is in that exact order.
    */
    if (sortMode === 'intent')
      query = query
        .order('intent_rank', { ascending: true, nullsFirst: false })
        .order('priority_score', { ascending: false, nullsFirst: false });
    else if (sortMode === 'value') query = query.order('estimated_value', { ascending: false, nullsFirst: false });
    // Most recently handed over first, and never a null export date at the top:
    // this sort exists to audit what was sent, so a page of unexported records
    // above the newest handover would defeat the only reason to pick it.
    else if (sortMode === 'exported')
      query = query
        .order('apollo_exported_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });
    else if (sortMode === 'newest' || !hasPriority) query = query.order('created_at', { ascending: false });
    else
      query = query
        .order('priority_score', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });

    return query.range(from, from + pageSize - 1);
  };

  const tiers: ColumnTier[] = ['full', 'routing', 'core'];
  const attempt = async (sortMode: RecordSort) => {
    for (const tier of tiers) {
      const { data, error, count } = await run(tier, sortMode);
      if (!error) return { rows: (data ?? []) as unknown as RecordRow[], total: count ?? 0 };
      if (!isMissingColumn(error)) break;
    }
    return null;
  };

  const requested: RecordSort = q.sort ?? 'priority';
  const first = await attempt(requested);
  if (first) return first;

  /*
    `intent_rank` is a generated column added by 20260812120000. Ordering on it
    before that migration lands fails every column tier, and the loop above would
    then return an empty list — a page of nothing that looks exactly like "no
    records match these filters".

    So a missing sort column falls back to priority rather than to silence. The
    order is not what was asked for, but the records are the right ones.
  */
  if (requested === 'intent') {
    const fallback = await attempt('priority');
    if (fallback) return fallback;
  }
  return { rows: [], total: 0 };
}

/** Live per-source ingest stats from canonical_projects (records + avg completeness). */
export interface SourceStat {
  count: number;
  avgCompleteness: number;
  lastIngested: string | null;
}
export async function getSourceStats(): Promise<Record<string, SourceStat>> {
  const supabase = await getReadSupabase();
  const agg: Record<string, { count: number; sum: number; last: string | null }> = {};

  /*
    Counted in the database — 75.8 seconds before this, reading all 109,552 rows to
    produce about 25. It was the slowest read in the app and the reason the last two
    test-mcp checks failed against their 60-second ceiling.

    The average is deliberately NOT computed in SQL. This function's average counts a
    null completeness as zero and still divides by every row (`Number(x) || 0`
    below); avg() would skip the nulls instead, which is a different number. So SQL
    returns the sum and the count, and the division stays exactly where it was — a
    performance fix must not quietly move a dashboard figure.
  */
  try {
    const { data, error } = await getServiceSupabase().rpc('source_stats');
    if (!error && Array.isArray(data)) {
      const out: Record<string, SourceStat> = {};
      for (const r of data as Record<string, unknown>[]) {
        const key = r.source_key as string;
        // bigint and numeric both arrive as strings over PostgREST; Number() before
        // any arithmetic or the totals become concatenated digits.
        const count = Number(r.n) || 0;
        const sum = Number(r.completeness_sum) || 0;
        out[key] = {
          count,
          avgCompleteness: count ? Math.round(sum / count) : 0,
          lastIngested: (r.last_ingested as string) ?? null,
        };
      }
      return out;
    }
  } catch {
    // Fall through to the walk below.
  }
  const PAGE = 1000;

  /*
    Keyset pagination, because this walks the WHOLE table and an index cannot help.

    Measured against 88,126 rows: page 1 of the old `.range()` walk took 255ms and
    page 40 timed out at 8.3 seconds. Offset paging asks Postgres to produce and
    throw away every row before the window, so page 40 pays for the previous
    40,000 and the cost grows with the square of the table. `id > last` reads the
    same 1,000 rows wherever it is in the table — the same query at page 40's
    depth came back in 700ms.

    No predicate here is selective — this function wants every row — so there is
    nothing an index could narrow. The problem was never a missing index.
  */
  let after = '';
  for (let guard = 0; guard < 500; guard += 1) {
    let q = supabase
      .from('canonical_projects')
      .select('id, source_key, population_percentage, created_at')
      // A total order is required either way, or a page boundary repeats and
      // skips rows — which would misreport how much each source contributed.
      .order('id', { ascending: true })
      .limit(PAGE);
    if (after) q = q.gt('id', after);

    const { data, error } = await q;
    if (error) return {};
    const batch = (data ?? []) as {
      id: string;
      source_key: string;
      population_percentage: number | null;
      created_at: string;
    }[];
    if (batch.length === 0) break;
    for (const r of batch) {
      const a = (agg[r.source_key] ??= { count: 0, sum: 0, last: null });
      a.count += 1;
      a.sum += Number(r.population_percentage) || 0;
      if (!a.last || r.created_at > a.last) a.last = r.created_at;
    }
    after = batch[batch.length - 1].id;
    if (batch.length < PAGE) break;
  }
  const out: Record<string, SourceStat> = {};
  for (const [k, v] of Object.entries(agg))
    out[k] = { count: v.count, avgCompleteness: v.count ? Math.round(v.sum / v.count) : 0, lastIngested: v.last };
  return out;
}

export interface AccountEnrichmentRow {
  account_key: string;
  account_name: string | null;
  account_role: string | null;
  parent_account: string | null;
  related_entities: Array<{
    name?: string;
    role?: string;
    relationship?: string;
    share?: number | string;
    lei?: string;
    entity_id?: string;
  }> | null;
  related_projects: Array<{ name?: string; location?: string; stage?: string; est_value?: number | null }> | null;
  portfolio_project_count: number | null;
  portfolio_value_estimate: number | null;
  expansion_signal: string | null;
  tech_stack: string[] | null;
  key_account: boolean;
  key_account_score: number | null;
  key_account_reasons: string[] | null;
  field_provenance: Record<string, string> | null;
}

export interface AccountDetail {
  /** A dedicated record_type='account' row, if one was ever imported. */
  account: CanonicalProjectRow | null;
  enrichment: AccountEnrichmentRow | null;
  /**
   * The aggregate the /accounts list is built from. An account exists as soon
   * as any record carries its key, so this is what decides whether the detail
   * page has anything to show.
   */
  view: AccountViewRow | null;
  projectCount: number;
  projects: CanonicalProjectRow[];
}

/** Everything about one account: its account record, enrichment, and any linked projects. */
export async function getAccountDetail(accountKey: string): Promise<AccountDetail> {
  const supabase = await getReadSupabase();
  try {
    const [acctRes, enrRes, viewRes, projRes] = await Promise.all([
      supabase
        .from('canonical_projects')
        .select('*')
        .eq('account_key', accountKey)
        .eq('record_type', 'account')
        .limit(1)
        .maybeSingle(),
      supabase.from('account_enrichment').select('*').eq('account_key', accountKey).maybeSingle(),
      supabase.from('accounts_view').select('*').eq('account_key', accountKey).maybeSingle(),
      supabase
        .from('canonical_projects')
        .select('*', { count: 'exact' })
        .eq('account_key', accountKey)
        .neq('record_type', 'account')
        .order('priority_score', { ascending: false, nullsFirst: false })
        .limit(50),
    ]);
    return {
      account: (acctRes.data as CanonicalProjectRow) ?? null,
      enrichment: (enrRes.data as AccountEnrichmentRow) ?? null,
      view: (viewRes.data as AccountViewRow) ?? null,
      projectCount: projRes.count ?? 0,
      projects: (projRes.data ?? []) as CanonicalProjectRow[],
    };
  } catch {
    return { account: null, enrichment: null, view: null, projectCount: 0, projects: [] };
  }
}

/** A row of accounts_view — a company rolled up across its projects + enrichment. */
export interface AccountViewRow {
  account_key: string;
  account_name: string | null;
  account_role: string | null;
  project_count: number;
  portfolio_project_count: number | null;
  with_contact: number;
  total_value: number | null;
  largest_project_value: number | null;
  capacity_mw: number | null;
  bus: string[] | null;
  verticals: string[] | null;
  key_account: boolean;
  key_account_score: number | null;
  key_account_reasons: string[] | null;
  related_projects: AccountEnrichmentRow['related_projects'];
  related_entities: AccountEnrichmentRow['related_entities'];
  expansion_signal: string | null;
}

export interface AccountsQuery {
  page?: number;
  pageSize?: number;
  keyOnly?: boolean;
  bu?: string;
  vertical?: string;
  search?: string;
}
export interface AccountsResult {
  rows: AccountViewRow[];
  total: number;
}

/** Paginated, filtered accounts — key accounts first, then by score. */
export async function getAccounts(q: AccountsQuery = {}): Promise<AccountsResult> {
  const supabase = await getReadSupabase();
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, q.pageSize ?? 100));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase.from('accounts_view').select('*', { count: 'exact' });
  if (q.keyOnly) query = query.eq('key_account', true);
  if (q.bu) query = query.contains('bus', [q.bu]);
  if (q.vertical) query = query.contains('verticals', [q.vertical]);
  if (q.search?.trim()) query = query.ilike('account_name', `%${q.search.trim().replace(/[%_]/g, '')}%`);

  query = query
    .order('key_account', { ascending: false })
    .order('key_account_score', { ascending: false, nullsFirst: false })
    .order('project_count', { ascending: false })
    .range(from, to);

  const { data, error, count } = await query;
  if (error) return { rows: [], total: 0 }; // view not created yet -> empty state
  return { rows: (data ?? []) as AccountViewRow[], total: count ?? 0 };
}

/**
 * One row per distinct combination, as `dashboard_rollup()` returns it.
 *
 * Shared by the two rollups below because both are folds over the SAME grouping —
 * getPipelineRollup wants (bu, vertical, contact_status) and getBuRollup wants bu
 * with reachable/assigned/exported. One aggregate, two folds, so the table is read
 * once rather than twice.
 */
export interface DashboardRollupRow {
  bu: string | null;
  vertical: string | null;
  contact_status: string | null;
  reachable: boolean;
  assigned: boolean;
  exported: boolean;
  n: number;
}

/**
 * Folds the aggregate onto (bu, vertical, contact_status).
 *
 * Exported for one reason: this is where a silent wrong number would live. The
 * aggregate splits each combination further by reachable/assigned/exported, so up
 * to eight rows collapse into one key here — and a fold that overwrote instead of
 * summing would report an eighth of the stock while looking entirely plausible on
 * screen. Pure, so it can be tested without a database. See scripts/test-rollup.mjs.
 */
export function foldPipelineRollup(rows: DashboardRollupRow[]): PipelineRollupRow[] {
  const grouped = new Map<string, PipelineRollupRow>();
  for (const r of rows) {
    const bu = r.bu as string;
    const vertical = r.vertical as string;
    const contact_status = r.contact_status as string;
    const key = `${bu}|${vertical}|${contact_status}`;
    const existing = grouped.get(key);
    if (existing) existing.count += r.n;
    else grouped.set(key, { bu, vertical, contact_status, count: r.n });
  }
  return Array.from(grouped.values());
}

/**
 * Folds the aggregate onto business unit.
 *
 * `waiting` is derived rather than grouped in SQL because it is exactly
 * `reachable and not assigned` — adding a grouping level for something computable
 * would widen the aggregate for nothing. `activeAssignees` is left at zero; the
 * caller fills it from the roster, which is a different table.
 */
export function foldBuRollup(rows: DashboardRollupRow[]): Map<string, BuRollupRow> {
  const acc = new Map<string, BuRollupRow>();
  for (const r of rows) {
    const bu = r.bu ?? 'unknown';
    const row = acc.get(bu) ?? { bu, total: 0, reachable: 0, assigned: 0, exported: 0, waiting: 0, activeAssignees: 0 };
    row.total += r.n;
    if (r.reachable) row.reachable += r.n;
    if (r.assigned) row.assigned += r.n;
    if (r.exported) row.exported += r.n;
    if (r.reachable && !r.assigned) row.waiting += r.n;
    acc.set(bu, row);
  }
  return acc;
}

/**
 * The aggregate, or null when it cannot be had.
 *
 * Null covers "the migration is not applied" and any other failure alike, because
 * both lead to the same place: the caller walks the table instead. That fallback is
 * why this returns null rather than throwing — a slow correct dashboard beats an
 * error page, and beats a panel that renders zero as though it were an answer.
 */
async function fetchDashboardRollup(): Promise<DashboardRollupRow[] | null> {
  try {
    const { data, error } = await getServiceSupabase().rpc('dashboard_rollup');
    if (error || !Array.isArray(data)) return null;
    return (data as Record<string, unknown>[]).map((r) => ({
      bu: (r.bu as string) ?? null,
      vertical: (r.vertical as string) ?? null,
      contact_status: (r.contact_status as string) ?? null,
      reachable: Boolean(r.reachable),
      assigned: Boolean(r.assigned),
      exported: Boolean(r.exported),
      // bigint arrives as a string over PostgREST; Number() before arithmetic or
      // the totals become concatenated digits.
      n: Number(r.n) || 0,
    }));
  } catch {
    return null;
  }
}

export async function getPipelineRollup(): Promise<PipelineRollupRow[]> {
  /*
    Counted in the database. This walked the whole table to produce ~96 grouped
    counts — 74.6 seconds measured against 109,552 rows, and the dashboard waited
    for it. Nothing about 96 counts requires 109,552 rows to cross the wire.
  */
  const rollup = await fetchDashboardRollup();
  if (rollup) return foldPipelineRollup(rollup);

  // Fallback: walk the table. Slow, and correct — see fetchDashboardRollup.
  const supabase = await getReadSupabase();
  const counts = new Map<string, PipelineRollupRow>();
  const PAGE = 1000; // Supabase caps each response at 1000 rows — page through all.
  for (let from = 0; from < 500_000; from += PAGE) {
    const { data, error } = await supabase
      .from('canonical_projects')
      .select('bu, vertical, contact_status')
      // Ordered, because an unordered `.range()` walk repeats and skips rows —
      // here it would overstate one BU's stock and understate another's.
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return from === 0 ? [] : Array.from(counts.values());
    for (const r of (data ?? []) as { bu: string; vertical: string; contact_status: string }[]) {
      const key = `${r.bu}|${r.vertical}|${r.contact_status}`;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { bu: r.bu, vertical: r.vertical, contact_status: r.contact_status, count: 1 });
    }
    if (!data || data.length < PAGE) break;
  }
  return Array.from(counts.values());
}

/**
 * One row per business unit: how much stock it holds, and whether anybody can
 * work it.
 *
 * The BU x vertical grid further down the dashboard answers "what have we got".
 * This answers the question that actually blocks throughput, which nothing showed:
 * a BU can hold thousands of reachable leads and have no active assignee whose
 * scope covers it, and then every one of them is unassignable at any quota. That
 * is the live situation — the NESO projects are `uk`, Calgary is `export`, the
 * Australian news is `apac`, and every active person is scoped to `usa`.
 *
 * `activeAssignees` is therefore part of the stat rather than a separate screen.
 * A row with stock and no owner is the finding.
 */
export interface BuRollupRow {
  bu: string;
  total: number;
  /** Has an email or a phone on the primary contact. */
  reachable: number;
  assigned: number;
  exported: number;
  /** Reachable, unassigned, and nobody is holding it — the workable backlog. */
  waiting: number;
  /** Active roster members whose scope covers this BU. Zero means stranded. */
  activeAssignees: number;
}

export async function getBuRollup(): Promise<{ rows: BuRollupRow[]; truncated: boolean }> {
  const supabase = getServiceSupabase();
  const acc = new Map<string, BuRollupRow>();
  const PAGE = 1000;
  const MAX_PAGES = 200;
  let truncated = false;

  /**
   * Coverage, from the roster rather than from the leads.
   *
   * Hoisted out of the two paths below so both get it — it was previously written
   * once at the end of the walk, and the aggregate path would have silently
   * reported every BU as stranded without it.
   *
   * An assignee with an EMPTY bu list is unrestricted on that axis and therefore
   * covers every BU. Reading empty as "covers nothing" would report the whole book
   * as unworkable.
   */
  const applyCoverage = async (rows: Map<string, BuRollupRow>) => {
    try {
      const { data } = await supabase.from('assignees').select('bu, is_active').eq('is_active', true);
      const active = (data ?? []) as { bu: string[] | null }[];
      for (const row of rows.values()) {
        row.activeAssignees = active.filter((a) => !a.bu?.length || a.bu.includes(row.bu)).length;
      }
    } catch {
      // Leave the counts at zero rather than inventing coverage.
    }
  };

  /*
    Counted in the database — 73.7 seconds measured against 109,552 rows before
    this, walking the whole table for a handful of per-BU totals while the dashboard
    waited on it.

    `waiting` is derived here rather than grouped in SQL because it is exactly
    `reachable and not assigned`, and adding a grouping level for something the
    caller can compute would widen the aggregate for nothing.
  */
  const rollup = await fetchDashboardRollup();
  if (rollup) {
    const folded = foldBuRollup(rollup);
    await applyCoverage(folded);
    return { rows: [...folded.values()].sort((a, b) => b.total - a.total), truncated: false };
  }

  // Fallback: walk the table. Slow, and correct — see fetchDashboardRollup.
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const { data, error } = await supabase
      .from('canonical_projects')
      .select('bu, contact_email, contact_phone, assignee_id, apollo_exported_at')
      // A stable key, or ranges overlap and one BU's stock is counted twice.
      .order('id', { ascending: true })
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) return { rows: [...acc.values()], truncated: true };
    const batch = (data ?? []) as {
      bu: string | null;
      contact_email: string | null;
      contact_phone: string | null;
      assignee_id: string | null;
      apollo_exported_at: string | null;
    }[];
    if (batch.length === 0) break;

    for (const r of batch) {
      const bu = r.bu ?? 'unknown';
      const row =
        acc.get(bu) ??
        { bu, total: 0, reachable: 0, assigned: 0, exported: 0, waiting: 0, activeAssignees: 0 };
      row.total += 1;
      const reachable = Boolean(r.contact_email || r.contact_phone);
      if (reachable) row.reachable += 1;
      if (r.assignee_id) row.assigned += 1;
      if (r.apollo_exported_at) row.exported += 1;
      if (reachable && !r.assignee_id) row.waiting += 1;
      acc.set(bu, row);
    }
    if (batch.length < PAGE) break;
  }

  // The same coverage pass the aggregate path uses, so the two cannot disagree.
  await applyCoverage(acc);

  return { rows: [...acc.values()].sort((a, b) => b.total - a.total), truncated };
}

// ============================================================================
// Priority + enrichment queue
// ============================================================================

/** Highest-priority records — the dashboard's "work this first" list. */
export async function getTopPriorityLeads(limit = 10): Promise<RecordRow[]> {
  const supabase = await getReadSupabase();
  const { data, error } = await supabase
    .from('canonical_projects')
    .select(
      'id,canonical_name,source_key,record_type,bu,vertical,ref_code,contact_status,country,capacity_mw,estimated_value,population_percentage,account_key,route,stage,priority_score,priority_band,priority_reasons,created_at'
    )
    .not('priority_score', 'is', null)
    .order('priority_score', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as RecordRow[];
}

/** How many records sit in each priority band — the scoring rollup. */
export interface DispositionRollup {
  total: number;
  /** Records carrying a priority band. */
  scored: number;
  /** Records carrying a materialized route. */
  routed: number;
  byBand: { band: string; count: number }[];
  byLane: { route: string; stage: string; count: number }[];
  /** Hours since the most recent routed_at — how stale the lanes are. */
  routedHoursAgo: number | null;
  /** Completeness tier A–E as delivered by the source, before enrichment. */
  byTier: { tier: string; count: number }[];
  /** Records a source gave no tier for. */
  untiered: number;
  /**
   * True when at least one count came back as an error rather than a number.
   *
   * This is what "data completeness shows 0" actually was. `countWhere` returns
   * null on failure and every caller writes `?? 0`, so a count that timed out
   * rendered as a real zero — indistinguishable from "no rows match". The tier
   * figures were 209 for A and 1,837 for P1 the whole time; the reads were
   * failing, not the data. A partial answer has to say so.
   */
  partial: boolean;
  /** How many of the counts failed, for the caller that wants to say. */
  failedCounts: number;
  /** True when the routing columns migration has not been applied. */
  routingMissing: boolean;
}

/**
 * Bands and lanes as they are WRITTEN on the records, in one scan.
 *
 * The routing page runs a live dry-run — it re-scores and re-routes everything
 * in memory to answer "what would these rules do". The dashboard needs the
 * opposite: what the lanes actually are right now, because that is what the
 * team can filter and work. Reading the materialized columns also means the
 * dashboard shows staleness honestly when the rules have moved on since the
 * last materialize.
 */
/**
 * Counted in the database, not in Node.
 *
 * This used to page every row of `canonical_projects` — 55 round trips and 54,346
 * rows over the wire — to produce about thirty numbers. It took 12 seconds, and
 * the Dashboard blocked on it, which is most of why navigating to `/` felt broken.
 *
 * Every figure here is a COUNT over a bounded, already-declared vocabulary
 * (PRIORITY_BANDS, ROUTES, STAGES, the completeness tiers A–E), so each one is a
 * `head: true` count that transfers no rows at all. Run concurrently, the whole
 * rollup costs about as much as a single page used to.
 *
 * The vocabularies are imported rather than retyped. A hardcoded list that drifts
 * from the real one would silently report zero for a band nobody noticed was
 * missing, which is worse than being slow.
 */
/**
 * The rollup in one round trip, or null if the function is not installed.
 *
 * Returns null rather than throwing on a missing function, so a workspace that
 * has not applied 20260811160000 falls through to the count fan-out instead of
 * losing the dashboard. Any OTHER error also returns null for the same reason —
 * the fallback reports its own failures, so nothing is being hidden by being
 * lenient here.
 */
async function dispositionViaRpc(supabase: SupabaseClient): Promise<DispositionRollup | null> {
  const startedAt = Date.now();
  /*
    No retry on a timeout, though it looks like an obvious win.

    The case for one was measured: 8,016 ms cold, 3,497 ms on the call straight
    after, against an ~8 s statement timeout. But those two calls were a tight
    loop with the cache already warm from the first, and in the real path the
    retry timed out as well — 10,206 ms — and then the count fan-out ran anyway.
    So the retry turned a 22 s worst case into a 31 s one and fixed nothing.

    The fix for a query on the boundary is to take it off the boundary, which is
    what 20260811170000 does by indexing the three predicates that were still
    doing full scans. A retry is what you reach for when you cannot do that.
  */
  const { data, error } = await supabase.rpc('disposition_rollup');

  if (error || !data) {
    /*
      Not logged as a failure when the function simply does not exist: that is a
      migration that has not been applied, not a fault, and an event per dashboard
      load would drown the log in something nobody can act on beyond running the
      migration once.
    */
    if (error && !/function|does not exist|schema cache/i.test(error.message)) {
      logEventAsync({
        kind: 'query',
        name: 'disposition_rollup.rpc',
        ok: false,
        durationMs: Date.now() - startedAt,
        detail: { error: error.message },
      });
    }
    return null;
  }

  const raw = data as {
    total?: number;
    scored?: number;
    routed?: number;
    by_band?: { band: string; count: number }[];
    by_tier?: { tier: string; count: number }[];
    by_lane?: { route: string; stage: string; count: number }[];
    last_routed?: string | null;
  };

  const byTierFound = new Map((raw.by_tier ?? []).map((t) => [t.tier, t.count]));
  const byBandFound = new Map((raw.by_band ?? []).map((b) => [b.band, b.count]));
  const total = raw.total ?? 0;
  const tiered = (raw.by_tier ?? []).reduce((n, t) => n + t.count, 0);

  /*
    The declared vocabulary is used to ORDER and to fill in zeros, not to decide
    what exists. A band the GROUP BY found that PRIORITY_BANDS does not name is
    appended rather than dropped — the old fan-out iterated the constant and so
    counted such a value by nobody, which is a silent undercount rather than a
    visible surprise.
  */
  const orderedBands = [
    ...PRIORITY_BANDS.map((band) => ({ band, count: byBandFound.get(band) ?? 0 })),
    ...(raw.by_band ?? []).filter((b) => !(PRIORITY_BANDS as readonly string[]).includes(b.band)),
  ];
  const orderedTiers = [
    ...COMPLETENESS_TIERS.map((tier) => ({ tier, count: byTierFound.get(tier) ?? 0 })),
    ...(raw.by_tier ?? []).filter((t) => !(COMPLETENESS_TIERS as readonly string[]).includes(t.tier)),
  ];

  logEventAsync({
    kind: 'query',
    name: 'disposition_rollup',
    ok: true,
    durationMs: Date.now() - startedAt,
    detail: { via: 'rpc', total, lanes: (raw.by_lane ?? []).length },
  });

  return {
    total,
    scored: raw.scored ?? 0,
    routed: raw.routed ?? 0,
    byBand: orderedBands,
    byLane: (raw.by_lane ?? []).filter((l) => l.count > 0),
    routedHoursAgo: raw.last_routed ? Math.round((Date.now() - new Date(raw.last_routed).getTime()) / 3_600_000) : null,
    byTier: orderedTiers,
    untiered: Math.max(0, total - tiered),
    /*
      The RPC has no routing column problem to detect: if `route` were missing the
      function would not have been created. A GROUP BY that returns no lanes means
      nothing has been routed, which is a fact rather than a missing column.
    */
    routingMissing: false,
    // One query either succeeds whole or fails whole, so there is no partial case.
    partial: false,
    failedCounts: 0,
  };
}

export async function getDispositionRollup(): Promise<DispositionRollup> {
  const supabase = await getReadSupabase();

  /*
    One GROUP BY if the database can do it, thirty-five counts if it cannot.

    The counts are not merely slow, they FAIL. Measured individually with nothing
    else running: an unfiltered count took 1,566 ms, `priority_band = 'P1'` took
    8,665 ms and returned null, `source_completeness_tier = 'A'` took 9,491 ms and
    returned null. Each filtered count sits on the statement timeout and lands
    either side of it at random, so serialising them stopped sixteen competing but
    made none of them fast — the activity log recorded `failedCounts=5` on every
    run at about 22 s a time.

    The fan-out below is kept as the fallback rather than deleted, because an
    environment that has not applied the migration must still render a dashboard.
    It is honest about failing, which is the most that path can be.
  */
  const viaRpc = await dispositionViaRpc(supabase);
  if (viaRpc) return viaRpc;

  /**
   * One `count` with no rows returned. `null` means the query failed, which is
   * how a missing routing column is detected rather than assumed.
   *
   * Filters are described as data rather than as a builder callback: threading
   * the PostgREST builder through a generic made the compiler give up with
   * "type instantiation is excessively deep", and the casts needed to silence
   * that were worse than the problem.
   */
  type CountFilter = { column: string; op: 'eq' } & { value: string } | { column: string; op: 'notNull' };
  /*
    Every count that failed used to become a zero.

    countWhere returned null on error and each caller wrote `?? 0`, so a timed-out
    count was indistinguishable from a real absence — the completeness card read
    "0 across every tier" and the priority bands read all zero, while the same
    counts run individually return 209 for tier A and 1,837 for P1. The data was
    never the problem.

    They were failing because roughly thirty-five full-table counts were fired at
    once inside Promise.all, and under that concurrency each one exceeded the
    statement timeout. So: bounded concurrency, and a failure is RECORDED rather
    than folded into the number.
  */
  const rollupStartedAt = Date.now();
  let failedCounts = 0;

  const countWhere = async (filters: CountFilter[] = []): Promise<number | null> => {
    let q = supabase.from('canonical_projects').select('id', { count: 'exact', head: true });
    for (const f of filters) {
      q = f.op === 'eq' ? q.eq(f.column, f.value) : q.not(f.column, 'is', null);
    }
    const { count, error } = await q;
    if (error) {
      failedCounts += 1;
      return null;
    }
    return count ?? 0;
  };

  /**
   * Runs the counts a few at a time.
   *
   * Four rather than one because sequential would take half a minute, and rather
   * than all because all is what broke it. Measured: individually these take
   * 1-2s each and succeed; thirty-five at once and they time out.
   */
  const inBatches = async <T>(tasks: (() => Promise<T>)[], width = 4): Promise<T[]> => {
    const out: T[] = [];
    for (let i = 0; i < tasks.length; i += width) {
      out.push(...(await Promise.all(tasks.slice(i, i + width).map((t) => t()))));
    }
    return out;
  };

  // Routing columns arrived in a later migration than the priority ones, so the
  // dashboard degrades to bands-only rather than showing nothing.
  let routingMissing = false;

  const [total, scored, routed] = await inBatches([
    () => countWhere(),
    () => countWhere([{ column: 'priority_band', op: 'notNull' }]),
    () => countWhere([{ column: 'route', op: 'notNull' }]),
  ]);
  if (routed === null) routingMissing = true;

  /*
    One group at a time, not four at once. Batching each group at four while
    running four groups concurrently is sixteen simultaneous full-table counts,
    which is most of the way back to the problem this is fixing.
  */
  const bandCounts = await inBatches(
    PRIORITY_BANDS.map((band) => async () => ({
      band,
      count: (await countWhere([{ column: 'priority_band', op: 'eq', value: band }])) ?? 0,
    }))
  );

  const laneCounts = routingMissing
    ? []
    : await inBatches(
        ROUTES.flatMap((route) =>
          STAGES.map((stage) => async () => ({
            route,
            stage,
            count:
              (await countWhere([
                { column: 'route', op: 'eq', value: route },
                { column: 'stage', op: 'eq', value: stage },
              ])) ?? 0,
          }))
        )
      );

  const tierCounts = await inBatches(
    COMPLETENESS_TIERS.map((tier) => async () => ({
      tier,
      count: (await countWhere([{ column: 'source_completeness_tier', op: 'eq', value: tier }])) ?? 0,
    }))
  );

  // The most recent routing stamp, as one ordered row rather than a scan for a max.
  const lastRouted = await (async () => {
    const { data, error } = await supabase
      .from('canonical_projects')
      .select('routed_at')
      .not('routed_at', 'is', null)
      .order('routed_at', { ascending: false })
      .limit(1);
    if (error) return null;
    return ((data ?? [])[0] as { routed_at?: string } | undefined)?.routed_at ?? null;
  })();

  const tiered = tierCounts.reduce((sum, t) => sum + t.count, 0);

  /*
    Recorded because this is where the dashboard's zeros came from, and a
    console.warn was not enough to find it: the failure had already rolled off
    the log stream by the time anyone asked why the card said nothing.

    Logged on a slow success too, not just on failure — the counts timing out is
    the failure mode, so the duration creeping towards the statement timeout is
    the warning that it is about to come back.
  */
  logEventAsync({
    kind: 'query',
    name: 'disposition_rollup',
    ok: failedCounts === 0,
    durationMs: Date.now() - rollupStartedAt,
    detail: { failedCounts, total: total ?? 0, tierA: tierCounts.find((t) => t.tier === 'A')?.count, routingMissing },
  });

  return {
    total: total ?? 0,
    scored: scored ?? 0,
    routed: routed ?? 0,
    byBand: bandCounts,
    // Empty lanes are dropped, matching the previous behaviour of only reporting
    // combinations that actually occur.
    byLane: laneCounts.filter((l) => l.count > 0).sort((a, b) => b.count - a.count),
    routedHoursAgo: lastRouted ? Math.round((Date.now() - new Date(lastRouted).getTime()) / 3_600_000) : null,
    byTier: tierCounts,
    // Derived, so a failed tier count inflates this rather than losing rows —
    // another reason `partial` has to travel with the numbers.
    untiered: Math.max(0, (total ?? 0) - tiered),
    routingMissing,
    partial: failedCounts > 0,
    failedCounts,
  };
}

export async function getPriorityRollup(): Promise<{ band: string; count: number; scored: number; total: number }[]> {
  const supabase = await getReadSupabase();
  const counts = new Map<string, number>();
  let total = 0;
  let scored = 0;
  for (let from = 0; from < 1_000_000; from += 1000) {
    const { data, error } = await supabase
      .from('canonical_projects')
      .select('priority_band')
      // Ordered, because an unordered `.range()` walk repeats and skips rows —
      // here it would misstate how much of the book has been scored at all.
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) break;
    for (const r of (data ?? []) as { priority_band: string | null }[]) {
      total += 1;
      if (r.priority_band) {
        scored += 1;
        counts.set(r.priority_band, (counts.get(r.priority_band) ?? 0) + 1);
      }
    }
    if (!data || data.length < 1000) break;
  }
  return ['P1', 'P2', 'P3', 'P4'].map((band) => ({ band, count: counts.get(band) ?? 0, scored, total }));
}

/** A record queued for enrichment, with everything /api/enrich needs as input. */
export interface EnrichQueueRow {
  id: string;
  canonical_name: string;
  source_key: string;
  record_type: string | null;
  icp_code: string | null;
  bu: string | null;
  vertical: string | null;
  company_name_raw: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_status: string | null;
  city: string | null;
  state_province: string | null;
  country: string | null;
  estimated_value: number | null;
  estimated_value_currency: string | null;
  project_url: string | null;
  description: string | null;
  priority_score: number | null;
  priority_band: string | null;
  route: string | null;
  stage: string | null;
  enriched_at: string | null;
  current_phase: string | null;
  construction_start_date: string | null;
  estimated_completion_date: string | null;
  announced_date: string | null;
  bid_date: string | null;
}

export interface EnrichQueueFilters {
  bu?: string;
  /**
   * Include projects that are already built or cancelled.
   *
   * Off by default: enrichment spends Apollo credits, and a finished project
   * cannot become a lead however well it scores. Turn on to re-enrich history.
   */
  includeUnreachable?: boolean;
  /**
   * Bands the policy permits — the standing eligibility rule.
   *
   * Distinct from `band`, which is one caller narrowing within it. Both apply.
   * Without this the only priority gate was `minPriority`, so a policy reading
   * "P1 and P2 only" admitted every P3 record above the floor: 1,172 of them,
   * 83% more records than the policy promised, each one billable.
   */
  bands?: string[];
  /** Business units eligible (empty/absent = all). */
  bus?: string[];
  /** Verticals eligible (empty/absent = all). */
  verticals?: string[];
  /** Country codes a person's region scope covers. */
  countries?: string[];
  /** Skip records worth less than this. Unpriced records are skipped too. */
  minEstimatedValue?: number;
  /** Skip records with no company name — Apollo has nothing to resolve. */
  requireCompany?: boolean;
  route?: string;
  stage?: string;
  band?: string;
  recordTypes?: string[];
  minPriority?: number;
  /** Skip records enriched within this many days (0 = re-enrich anything). */
  reenrichAfterDays?: number;
  onlyMissingContact?: boolean;
  /** Lifecycle statuses eligible to be claimed. Defaults to RAW + queued. */
  statuses?: string[];
  limit?: number;
}

/** Idle statuses — safe to claim without racing a worker or reviving a dead lead. */
export const CLAIMABLE_STATUSES = ['RAW', 'PENDING_ENRICHMENT', 'ENRICHED'];

const ENRICH_QUEUE_COLUMNS =
  'id,canonical_name,source_key,record_type,icp_code,bu,vertical,company_name_raw,contact_name,contact_email,' +
  'contact_phone,contact_status,city,state_province,country,estimated_value,estimated_value_currency,project_url,' +
  'description,priority_score,priority_band,route,stage,enriched_at,' +
  // Phase and dates travel with the queue row so the call brief can say how
  // early we are arriving. Without them the brief was written blind to timing,
  // which for Evercam is the pitch.
  'current_phase,construction_start_date,estimated_completion_date,announced_date,bid_date';

function applyQueueFilters<
  T extends {
    eq: (c: string, v: unknown) => T;
    in: (c: string, v: unknown[]) => T;
    gte: (c: string, v: unknown) => T;
    or: (f: string) => T;
    not: (c: string, op: string, v: unknown) => T;
    is: (c: string, v: unknown) => T;
  },
>(query: T, f: EnrichQueueFilters): T {
  let q = query;
  if (f.bu) q = q.eq('bu', f.bu);
  if (f.bus?.length) q = q.in('bu', f.bus);
  if (f.verticals?.length) q = q.in('vertical', f.verticals);
  // Region scope. The roster stores country codes in `regions`, and without this
  // a person scoped to the USA had their scope honoured at ASSIGNMENT but ignored
  // when deciding what to PRODUCE — so the tank filled with leads they could
  // never be given.
  if (f.countries?.length) q = q.in('country', f.countries);
  // Never re-enrich a lead already handed to Apollo. This was true only by
  // accident before — `onlyMissingContact` happened to exclude them, and that is
  // a policy flag somebody can turn off, at which point we would have paid to
  // enrich leads that had already left the building.
  q = q.is('apollo_exported_at', null);
  // gte on a nullable column drops NULLs, which is the intent: a record with no
  // value has not been shown to clear the bar.
  if (f.minEstimatedValue) q = q.gte('estimated_value', f.minEstimatedValue);
  if (f.requireCompany) q = q.not('company_name_raw', 'is', null);
  if (f.route) q = q.eq('route', f.route);
  if (f.stage) q = q.eq('stage', f.stage);
  if (f.bands?.length) q = q.in('priority_band', f.bands);
  if (f.band) q = q.eq('priority_band', f.band);
  if (f.recordTypes?.length) q = q.in('record_type', f.recordTypes);
  if (f.minPriority !== undefined) q = q.gte('priority_score', f.minPriority);
  if (f.onlyMissingContact !== false) q = q.eq('contact_status', 'needs_enrichment');
  // Only records that are genuinely idle. Excluding ENRICHING stops a second
  // worker double-spending on a record already in flight; excluding the
  // terminal statuses stops money going to leads nobody will ever work.
  if (f.statuses?.length) q = q.in('status', f.statuses);
  if (f.reenrichAfterDays && f.reenrichAfterDays > 0) {
    const cutoff = new Date(Date.now() - f.reenrichAfterDays * 86_400_000).toISOString();
    // never enriched, or last enriched before the cutoff
    q = q.or(`enriched_at.is.null,enriched_at.lt.${cutoff}`);
  }
  return q;
}

export interface ProductionState {
  /** Enriched so far this calendar month. */
  produced: number;
  /** The month's goal, from `monthlyReadyTarget`. */
  target: number;
  /** produced / target, 0..1. */
  progress: number;
  /** Combined daily_lead_quota of the active roster — what the team draws a day. */
  dailyDemand: number;
  /** Enriched, contactable, not yet exported — unsold stock right now. */
  ready: number;
  /** How many of those export would send today: it also needs an assignee. */
  exportable: number;
  /**
   * Ready stock that at least one active assignee's scope covers.
   *
   * `ready` counts everything unexported and contactable, which overstates cover:
   * a lead no scope reaches can never be given to anybody, so it will never be
   * exported no matter how many days pass.
   */
  assignable: number;
  /**
   * Ready stock no active scope reaches. Measured at 86 of 384 — usa/pipeline
   * (27), which nobody's verticals name, plus apac/export leads while every
   * active person is scoped `bu: ["usa"]`.
   *
   * Not waste: it is stock waiting for a scope decision, and it is the difference
   * between "enrich more" and "widen a scope", which are very different bills.
   */
  unassignableReady: number;
  /**
   * Days of cover, from `assignable` rather than `ready`.
   *
   * This read 4.1 while the thinnest desk held 0.2 days, because it divided the
   * whole 408 by the team's combined draw. A team average hides an empty desk by
   * construction, and counting leads nobody can be given inflates it further. Use
   * `planSupply` for the per-person figure, which is the one that predicts whether
   * somebody stops working.
   */
  daysOfCover: number;
  /** Records still needed this month to hit target. */
  remaining: number;
  /** Set when enrichment should not run, and why. */
  reason: string | null;
}

/**
 * Has this month's production target been met?
 *
 * The target is a FLOW — enriched leads produced per calendar month — not a stock
 * level. A stock rule ("hold 240 and stop") starves a team that consumes daily:
 * it stops producing the moment the shelf looks full and never accounts for what
 * was taken off it. Counting production per month bounds the Apollo spend by a
 * number somebody chose, and keeps producing while the team keeps drawing.
 *
 * `ready` and `exportable` are reported alongside, because they answer a
 * different question — how much unsold stock exists, and how much of it export
 * could actually send today. A wide gap between them means assignment is behind,
 * which is not a production problem and must not be mistaken for one.
 */
export async function getProductionState(
  monthlyReadyTarget: number,
  now: Date = new Date()
): Promise<ProductionState> {
  const supabase = await getReadSupabase();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const [{ count: produced, error: producedError }, { count: ready }, { count: exportable }, { data: roster }] =
    await Promise.all([
      supabase
        .from('canonical_projects')
        .select('*', { count: 'exact', head: true })
        .gte('enriched_at', monthStart),
      supabase
        .from('canonical_projects')
        .select('*', { count: 'exact', head: true })
        .not('enriched_at', 'is', null)
        .not('contact_email', 'is', null)
        .is('apollo_exported_at', null)
        .eq('do_not_contact', false),
      supabase
        .from('canonical_projects')
        .select('*', { count: 'exact', head: true })
        .not('contact_email', 'is', null)
        .is('apollo_exported_at', null)
        .eq('do_not_contact', false)
        .not('assignee_id', 'is', null)
        .in('status', ['ASSIGNED', 'CONTACTED', 'PREPARED']),
      supabase.from('assignees').select('daily_lead_quota, bu, verticals, preferred_verticals').eq('is_active', true),
    ]);

  const dailyDemand = (roster ?? []).reduce(
    (n, r) => n + ((r as { daily_lead_quota: number | null }).daily_lead_quota ?? 0),
    0
  );
  const readyCount = ready ?? 0;

  /*
    How much of that stock anybody can actually be given.

    A head-count cannot answer this — the scope test is per row against every
    active person — so it costs one paged read of bu/vertical for the unassigned
    part. That is a few hundred rows, not the table, because already-assigned
    stock is assignable by definition and is added back below.

    Measured on this book: 384 unassigned ready, of which 86 match no active
    scope. Dividing the full 408 by the team draw reported 4.1 days of cover while
    the thinnest desk held 0.2.
  */
  const scopes = ((roster ?? []) as Record<string, unknown>[]).map((r) => {
    const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]).filter((x) => typeof x === 'string') : []);
    // `verticals` is the hard filter; `preferred_verticals` only narrows when it
    // is empty — the same precedence assignment itself applies, so the two cannot
    // disagree about who covers what.
    const verticals = list(r.verticals).length ? list(r.verticals) : list(r.preferred_verticals);
    return { bu: list(r.bu), verticals };
  });
  const coveredBySomeone = (bu: string | null, vertical: string | null): boolean =>
    scopes.some(
      (sc) =>
        (!sc.bu.length || (bu != null && sc.bu.includes(bu))) &&
        (!sc.verticals.length || (vertical != null && sc.verticals.includes(vertical)))
    );

  let unassignableReady = 0;
  let assignableUnassigned = 0;
  {
    let after = '';
    for (let page = 0; page < 10; page += 1) {
      let q = supabase
        .from('canonical_projects')
        .select('id, bu, vertical')
        .not('enriched_at', 'is', null)
        .not('contact_email', 'is', null)
        .is('apollo_exported_at', null)
        .eq('do_not_contact', false)
        .is('assignee_id', null)
        .order('id', { ascending: true })
        .limit(1000);
      if (after) q = q.gt('id', after);
      const { data: rows, error: scopeError } = await q;
      /*
        On a failed read, stop and leave the counts as they stand rather than
        treating the remainder as unassignable. Overstating what nobody can be
        given would argue for widening a scope that may be fine.
      */
      if (scopeError || !rows?.length) break;
      for (const r of rows as { id: string; bu: string | null; vertical: string | null }[]) {
        if (coveredBySomeone(r.bu, r.vertical)) assignableUnassigned += 1;
        else unassignableReady += 1;
      }
      after = (rows[rows.length - 1] as { id: string }).id;
      if (rows.length < 1000) break;
    }
  }

  // Already-assigned stock is assignable by definition — somebody holds it.
  const assignable = assignableUnassigned + (exportable ?? 0);
  const daysOfCover = dailyDemand > 0 ? Math.round((assignable / dailyDemand) * 10) / 10 : 0;

  // A count we could not take is not a met target. Failing open keeps production
  // going; failing closed would stop the month's supply over a transient read.
  if (producedError) {
    console.warn(`Could not measure this month's production: ${producedError.message}`);
    return {
      produced: 0,
      target: monthlyReadyTarget,
      progress: 0,
      dailyDemand,
      ready: readyCount,
      exportable: exportable ?? 0,
      assignable,
      unassignableReady,
      daysOfCover,
      remaining: monthlyReadyTarget,
      reason: null,
    };
  }

  const made = produced ?? 0;
  const remaining = Math.max(0, monthlyReadyTarget - made);
  const reason =
    monthlyReadyTarget > 0 && remaining === 0
      ? `This month's target of ${monthlyReadyTarget.toLocaleString()} enriched leads is met (${made.toLocaleString()} produced). Enrichment is paused until the first of next month so the Apollo spend stays inside the month's budget.`
      : null;

  return {
    produced: made,
    target: monthlyReadyTarget,
    progress: monthlyReadyTarget > 0 ? Math.min(1, made / monthlyReadyTarget) : 1,
    dailyDemand,
    ready: readyCount,
    exportable: exportable ?? 0,
    assignable,
    unassignableReady,
    daysOfCover,
    remaining,
    reason,
  };
}

export interface EnrichQueueResult {
  rows: EnrichQueueRow[];
  /**
   * Eligible records, or NULL when the count could not be obtained.
   *
   * Not zero. Zero is a fact about the book — "nothing is eligible" — and null is
   * a fact about this request: we failed to ask. Reporting the second as the first
   * is how a control centre tells a seller there is nothing to call when really
   * the query timed out.
   */
  total: number | null;
  unreachableSkipped: number;
  /**
   * True when the ROWS could not be read. Distinct from an empty queue, and the
   * caller is expected to say so rather than render emptiness.
   */
  failed: boolean;
}

/**
 * The enrichment queue: records eligible under the policy, highest priority
 * first. This is the exact selection the batch endpoint processes, so the
 * control centre can show the queue before spending anything on it.
 */
export async function getEnrichmentQueue(f: EnrichQueueFilters = {}): Promise<EnrichQueueResult> {
  const supabase = await getReadSupabase();
  const want = Math.min(500, Math.max(1, f.limit ?? 50));

  /**
   * Ask for more than we need, because rows are dropped after they arrive.
   *
   * "Already built" is decided by `arrivalFor`, which reads the admin-editable
   * phase table — so expressing it in SQL would mean maintaining the same list
   * of phases in two places, and they would drift. Over-fetching keeps one
   * source of truth, at the cost of a wider read.
   */
  const overfetch = f.includeUnreachable ? want : Math.min(500, want * 4);

  const filtersFor = (withStatus: boolean) =>
    withStatus ? { ...f, statuses: f.statuses ?? CLAIMABLE_STATUSES } : { ...f, statuses: undefined };

  /*
    Rows and count are SEPARATE queries, and this is a performance fix as much as
    a correctness one.

    They used to be one `select(columns, { count: 'exact' })`. PostgREST computes
    the exact count in the same statement as the ordered page, and that combination
    is what blew the statement timeout — measured 2026-08-13 against the live table:

      data + inline exact count      5,022ms   (9,139ms on the run that failed)
      data only, no count              414ms
      exact count as its own head      410ms

    Twelve times faster apart than together, and comfortably inside the timeout
    instead of sitting on it. `count: 'exact'` is kept, because the slowness was
    never the counting — it was counting and sorting in one statement. No need to
    trade an accurate number for a planner estimate.
  */
  const runRows = async (withStatus: boolean) => {
    const columns = withStatus ? `${ENRICH_QUEUE_COLUMNS},status` : ENRICH_QUEUE_COLUMNS;
    const base = supabase.from('canonical_projects').select(columns);
    const query = applyQueueFilters(base as never, filtersFor(withStatus)) as unknown as typeof base;
    return query.order('priority_score', { ascending: false, nullsFirst: false }).limit(overfetch);
  };

  const runCount = async (withStatus: boolean) => {
    const base = supabase.from('canonical_projects').select('id', { count: 'exact', head: true });
    return applyQueueFilters(base as never, filtersFor(withStatus)) as unknown as typeof base;
  };

  /**
   * The eligible count, or null when it cannot be obtained.
   *
   * Independent of the rows on purpose: a failed count must not empty the queue,
   * and an empty queue must not be blamed on the count.
   */
  const countTotal = async (): Promise<number | null> => {
    try {
      let { count, error } = await runCount(true);
      if (isMissingColumn(error)) ({ count, error } = await runCount(false));
      return error ? null : (count ?? null);
    } catch {
      return null;
    }
  };

  const fetchRows = async () => {
    // Prefer the lifecycle-aware query; fall back to the pre-lifecycle shape
    // when that migration hasn't run, so the queue still works rather than
    // silently reporting zero eligible records.
    let { data, error } = await runRows(true);
    if (isMissingColumn(error)) ({ data, error } = await runRows(false));
    return { data, error };
  };

  try {
    /*
      In PARALLEL, because they are now two independent statements and waiting for
      one before starting the other simply adds the two latencies together.
      Measured 2026-08-13: rows 1,183ms, count 479–3,416ms depending on cache,
      both together 523ms.
    */
    const [{ data, error }, total] = await Promise.all([fetchRows(), countTotal()]);
    // `failed`, not an empty queue. The caller has to be able to tell a seller
    // "this did not load" instead of "there is nothing to call".
    if (error) return { rows: [], total, unreachableSkipped: 0, failed: true };

    const fetched = (data ?? []) as unknown as EnrichQueueRow[];
    if (f.includeUnreachable) return { rows: fetched.slice(0, want), total, unreachableSkipped: 0, failed: false };

    /**
     * Drop the projects that are cold — built, cancelled, commissioning, or
     * already mid-build. See COLD_ARRIVALS.
     *
     * Not a change of SCOPE — every record stays in the table, on the list, and
     * says how early we are. It is a change of SPEND: buying contacts for a
     * plant that started operating in 2019 produces a lead nobody can sell, and
     * the priority score cannot prevent that on its own, because a large owner
     * scores well on value, ICP and key-account whether or not this particular
     * asset is finished.
     *
     * Measured before this: of ~111 records enriched, 13 were built or dead and
     * only 11 were in-scope construction projects.
     */
    const keep = fetched.filter((r) => !isColdArrival(r));
    /*
      Ordered by how early we are arriving, then by how early the SOURCE speaks.

      `compareArrival` sorts on the verdict first and only uses the source lead to
      break ties WITHIN `unconfirmed` — the 63% of the book that carries no usable
      date, where an issued building permit and a grid-queue entry are otherwise
      indistinguishable. A dated verdict already knows more than its publisher does,
      so it is never reordered by the catalog.

      MEASURED 2026-08-18, and worth being straight about: on the current window this
      changes nothing. The queue comes back 58 pre_project/`unconfirmed` and 42 GEM
      `on_time`, and `on_time` outranks `unconfirmed` regardless of source — which is
      correct, because a phase table explicitly saying "pre-construction" beats a
      prior about what the publisher usually carries. It bites when one window holds
      undated records from sources of different lead, which is the direction the book
      moves as the interconnection queues grow.

      The sort is stable, so records with an equal verdict and lead keep the
      priority_score order the query returned them in.
    */
    const ordered = keep
      .map((r) => ({ r, a: arrivalFor(r) }))
      .sort((x, y) => compareArrival(x.a, y.a))
      .map((x) => x.r);
    return {
      rows: ordered.slice(0, want),
      total,
      // Only what was seen on this page. The database count is unfiltered, and
      // extrapolating a global figure from a sample would be a guess presented
      // as a number.
      unreachableSkipped: fetched.length - keep.length,
      failed: false,
    };
  } catch {
    // Nothing completed, so there is no count either — null, not zero.
    return { rows: [], total: null, unreachableSkipped: 0, failed: true };
  }
}

/** Past batch enrichment jobs, newest first — the run history. */
export interface EnrichmentRunRow {
  id: string;
  filters: Record<string, unknown> | null;
  requested: number;
  succeeded: number;
  failed: number;
  skipped: number;
  engines: Record<string, boolean> | null;
  fields_added: number;
  contacts_found: number;
  error: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export async function getEnrichmentRuns(limit = 20): Promise<EnrichmentRunRow[]> {
  const supabase = await getReadSupabase();
  try {
    const { data, error } = await supabase
      .from('enrichment_runs')
      .select(
        'id,filters,requested,succeeded,failed,skipped,engines,fields_added,contacts_found,error,status,started_at,finished_at,duration_ms'
      )
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data ?? []) as EnrichmentRunRow[];
  } catch {
    return [];
  }
}

/** Records enriched in the last 24h — enforces the policy's daily cap. */
/** Records enriched in the last N days — backs the daily and monthly rails. */
/**
 * How many records enrichment has produced in a window, or NULL if unknown.
 *
 * Null rather than zero, because this feeds the spend rails. It used to end
 * `if (error) return 0`, and the caller read that as "nothing enriched yet" — so
 * a cap of 600 with an unmeasurable usage became a cap of infinity. Measured:
 * this count was being cancelled by the statement timeout every time, so both
 * rails had been reading zero used for as long as the table has been too big to
 * scan.
 *
 * That is the one silent zero in this app that SPENDS MONEY rather than just
 * misreporting, so the caller is now forced to handle not-knowing.
 */
export async function getEnrichedSinceCount(days: number): Promise<number | null> {
  const supabase = await getReadSupabase();
  const startedAt = Date.now();
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const { count, error } = await supabase
      .from('canonical_projects')
      .select('id', { count: 'exact', head: true })
      .gte('enriched_at', since);
    if (error) {
      logEventAsync({
        kind: 'query',
        name: 'enriched_since_count',
        ok: false,
        durationMs: Date.now() - startedAt,
        detail: { days, error: error.message || 'empty error — usually a cancelled statement' },
      });
      return null;
    }
    return count ?? 0;
  } catch (err) {
    logEventAsync({
      kind: 'query',
      name: 'enriched_since_count',
      ok: false,
      durationMs: Date.now() - startedAt,
      detail: { days, error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

export async function getEnrichedTodayCount(): Promise<number> {
  const supabase = await getReadSupabase();
  try {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { count, error } = await supabase
      .from('canonical_projects')
      .select('id', { count: 'exact', head: true })
      .gte('enriched_at', since);
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

// ============================================================================
// export_runs
// ============================================================================

export interface ExportRunRow {
  id: string;
  destination: string;
  trigger: string;
  triggeredBy: string | null;
  /** What the run was scoped to — assignee, BU, limit. */
  filters: { assignee?: string | null; bu?: string | null; limit?: number | null; label?: string | null };
  requested: number;
  created: number;
  existing: number;
  failed: number;
  batches: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

/**
 * Export history, newest first.
 *
 * Ordered by `started_at`, which is the only chronological column here — `id` is
 * a uuid, so ordering by it returns an arbitrary run and calls it the latest.
 *
 * The route has always written these rows; nothing read them, so "did the export
 * run, and what did it send" could only be answered by re-running it. Apollo
 * itself cannot answer it — it emits no notification on contact creation.
 */
/**
 * How long an export may be `running` before it is presumed dead.
 *
 * The export route's own ceiling is 300 seconds and a full 500-contact send
 * measured about four minutes, so nothing legitimate is still going after
 * thirty. A row older than that is a process that was killed or lost its
 * container somewhere the finishing write could not reach.
 *
 * The same fault as `ingestion_runs` had: a row is opened before the work
 * starts so an interrupted send stays visible, and nothing ever closed the ones
 * that never came back. One of mine sat there after a request was cut off
 * mid-flight, indistinguishable on the page from a send in progress.
 */
const STALE_EXPORT_MS = 30 * 60 * 1000;

async function reapStaleExportRuns(): Promise<void> {
  try {
    await getServiceSupabase()
      .from('export_runs')
      .update({
        status: 'failed',
        error: 'Interrupted — the process ended before the send could finish.',
        finished_at: new Date().toISOString(),
      })
      .eq('status', 'running')
      .lt('started_at', new Date(Date.now() - STALE_EXPORT_MS).toISOString());
  } catch {
    // Best-effort: a failed reap must not hide the history it was tidying.
  }
}

export async function getExportRuns(limit = 50): Promise<{ rows: ExportRunRow[]; tableMissing: boolean }> {
  try {
    const service = getServiceSupabase();
    // Never show a dead send as live.
    await reapStaleExportRuns();
    const { data, error } = await service
      .from('export_runs')
      .select(
        'id, destination, trigger, triggered_by, filters, requested, created, existing, failed, batches, status, started_at, finished_at, duration_ms, error'
      )
      .order('started_at', { ascending: false })
      .limit(limit);

    if (error) {
      return { rows: [], tableMissing: /does not exist|schema cache|relation/i.test(error.message) };
    }

    const rows = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      destination: (r.destination as string) ?? 'apollo',
      trigger: (r.trigger as string) ?? 'manual',
      triggeredBy: (r.triggered_by as string) ?? null,
      filters: (r.filters as ExportRunRow['filters']) ?? {},
      requested: (r.requested as number) ?? 0,
      created: (r.created as number) ?? 0,
      existing: (r.existing as number) ?? 0,
      failed: (r.failed as number) ?? 0,
      batches: (r.batches as number) ?? 0,
      status: (r.status as string) ?? 'running',
      startedAt: r.started_at as string,
      finishedAt: (r.finished_at as string) ?? null,
      durationMs: (r.duration_ms as number) ?? null,
      error: (r.error as string) ?? null,
    }));

    return { rows, tableMissing: false };
  } catch {
    return { rows: [], tableMissing: true };
  }
}

// ============================================================================
// Handover by person
// ============================================================================

export interface HandoverRow {
  assigneeId: string;
  name: string;
  isActive: boolean;
  dailyQuota: number;
  /** Leads already sent to Apollo. */
  received: number;
  /** Leads that would go on the next run — every gate already satisfied. */
  ready: number;
  /** Assigned, but with no address to send. Enrichment's queue, not the export's. */
  waitingOnContact: number;
  /** Has an address, but the policy demands a verified one and it is not. */
  blockedUnverified: number;
  /** Assigned and flagged do-not-contact. */
  doNotContact: number;
}

export interface HandoverBreakdown {
  rows: HandoverRow[];
  /**
   * Days of cover per person, against their own quota.
   *
   * Attached here because `ready` is computed here and the plan is arithmetic on
   * it — recomputing elsewhere would be a second definition of "ready", and this
   * page already learned what happens when two of those disagree.
   */
  supply: SupplyPlan;
  /** What to do about each short desk. Empty when nobody is short, or unmeasurable. */
  advice: RebalanceAdvice[];
  /** Assigned to somebody no longer on the roster — nobody is working these. */
  unrostered: number;
  /** True when the policy requires a verified address, which changes `ready`. */
  requireVerified: boolean;
  tableMissing: boolean;
}

/**
 * Who received leads, against what is ready to go to them.
 *
 * The dashboard could say how many leads were handed over but not to whom, and
 * not what was waiting — so "the export sent nothing" and "there was nothing to
 * send" looked identical, which is the question actually asked after a run.
 *
 * The gates mirror `/api/export/apollo` exactly, including reading
 * `requireChannel` from the policy. A readiness figure computed from different
 * rules than the export uses is worse than none: it would promise leads that the
 * next run then declines to send.
 */
/** PostgREST refuses to return more than this many rows in one response. */
const HANDOVER_PAGE = 1000;

export async function getHandoverByPerson(): Promise<HandoverBreakdown> {
  const empty: HandoverBreakdown = {
    rows: [],
    supply: planSupply([]),
    advice: [],
    unrostered: 0,
    requireVerified: false,
    tableMissing: false,
  };
  try {
    const service = getServiceSupabase();
    const { config: policy } = await getEnrichmentPolicy();
    const requireVerified = policy.requireChannel;

    const { data: rosterRows, error: rosterError } = await service
      .from('assignees')
      .select('id, name, is_active, daily_lead_quota, bu, verticals');
    if (rosterError) {
      return { ...empty, tableMissing: /does not exist|schema cache|relation/i.test(rosterError.message) };
    }
    const roster = (rosterRows ?? []) as {
      id: string;
      name: string;
      is_active: boolean;
      daily_lead_quota: number | null;
      bu: string[] | null;
      verticals: string[] | null;
    }[];

    // Paged, because PostgREST caps a response at 1000 rows and a silent
    // truncation here would under-report somebody's book as complete.
    const leads: Record<string, unknown>[] = [];
    for (let page = 0; page < 200; page += 1) {
      const { data, error } = await service
        .from('canonical_projects')
        .select('assignee_id, apollo_exported_at, contact_name, contact_email, contact_phone, additional_contacts, company_name_raw, stage, email_verified, do_not_contact, status')
        .not('assignee_id', 'is', null)
        // Total order, so each range is a stable slice rather than an arbitrary one.
        .order('id', { ascending: true })
        .range(page * HANDOVER_PAGE, (page + 1) * HANDOVER_PAGE - 1);
      if (error) return { ...empty, tableMissing: /does not exist|schema cache/i.test(error.message) };
      if (!data?.length) break;
      leads.push(...(data as Record<string, unknown>[]));
      if (data.length < HANDOVER_PAGE) break;
    }

    const EXPORTABLE = new Set(['ASSIGNED', 'CONTACTED', 'PREPARED']);
    const byId = new Map<string, HandoverRow>();
    for (const r of roster) {
      byId.set(r.id, {
        assigneeId: r.id,
        name: r.name,
        isActive: r.is_active,
        dailyQuota: r.daily_lead_quota ?? 0,
        received: 0,
        ready: 0,
        waitingOnContact: 0,
        blockedUnverified: 0,
        doNotContact: 0,
      });
    }

    let unrostered = 0;
    for (const l of leads) {
      const row = byId.get(l.assignee_id as string);
      if (!row) {
        unrostered += 1;
        continue;
      }
      if (l.apollo_exported_at) {
        row.received += 1;
        continue;
      }
      // Order matters: each lead is counted under its FIRST blocking reason, so
      // the columns sum to the book rather than double-counting it.
      if (l.do_not_contact) row.doNotContact += 1;
      /*
        Reachability comes from the EXPORT's own rule, not from "has an email".

        This asked whether contact_email was set, and the export asks the policy's
        channelRules what the lead's lane needs — with act_now on 'phone', a
        number is enough — and it counts the committee as well as the primary
        contact. So this page reported 96 leads waiting and 0 ready while the
        export would have sent 41 of them, and a rep was told their whole book was
        stuck. Shared helper now, so the two cannot drift apart again.
      */
      else if (!recordReachable(l as never, policy.channelRules)) row.waitingOnContact += 1;
      else if (!EXPORTABLE.has(String(l.status))) row.waitingOnContact += 1;
      else if (requireVerified && l.email_verified !== true) row.blockedUnverified += 1;
      else row.ready += 1;
    }

    const rows = [...byId.values()]
      // Anyone who has never held a lead and cannot receive one is noise.
      .filter((r) => r.isActive || r.received > 0 || r.ready > 0 || r.waitingOnContact > 0)
      .sort((a, b) => b.received + b.ready - (a.received + a.ready) || a.name.localeCompare(b.name));

    /*
      Cover is measured from stock IN SCOPE, not from assigned-but-unsent work.

      The first version used `ready` — assigned, reachable, not yet exported — and
      that quantity cannot accumulate: assignment is capped at the daily quota and
      the daily job exports in the same pass, so the drain equals the fill and
      every desk reads as roughly zero days forever. What protects a desk is how
      much reachable stock exists that this person could be given, which is the
      number the enrichment planner already computes as `covered`.

      Read from getDemandPlan rather than recomputed, so there is one definition
      of it. This page has already been through what happens when two parts of the
      app measure the same word differently.
    */
    let supply = planSupply([]);
    try {
      const demand = await getDemandPlan(policy.monthlyReadyTarget);
      /*
        A read that failed is not a measurement of zero. Presenting it as one
        reports every desk as empty when they may be full, which is how somebody
        ends up authorising enrichment spend against a number nobody took.
      */
      if (demand.inventoryUnavailable) throw new Error(demand.inventoryUnavailable);
      const byId = new Map(demand.people.map((d) => [d.id, d]));
      supply = planSupply(
        rows.map((r) => ({
          assigneeId: r.assigneeId,
          name: r.name,
          dailyQuota: r.dailyQuota,
          // Absent from the demand plan means inactive or zero-quota, and
          // planSupply drops those anyway.
          covered: byId.get(r.assigneeId)?.covered ?? 0,
          isActive: r.isActive,
        }))
      );
    } catch {
      // A supply figure we could not measure is better absent than invented.
    }

    /*
      Advice for EVERY short desk, not just the worst one.

      adviseRebalance existed and nothing called it, so none of this reached the
      screen — the numbers said who was short and left the reader to work out what
      to do about it, which on this roster is not guessable: two of the three
      shortfalls need only an assignment run, and the third cannot be fixed by
      moving leads at all because no available stock matches that scope.

      The stock read is one extra query, and cheap now the ready-inventory index
      exists — it was this call timing out that made cover unmeasurable at all.
    */
    let advice: RebalanceAdvice[] = [];
    if (supply.shortCount > 0) {
      try {
        const buckets = new Map<string, number>();
        let after = '';
        for (let guard = 0; guard < 20; guard += 1) {
          let q = service
            .from('canonical_projects')
            .select('id, bu, vertical')
            .is('assignee_id', null)
            .not('enriched_at', 'is', null)
            .not('contact_email', 'is', null)
            .is('apollo_exported_at', null)
            .eq('do_not_contact', false)
            .order('id', { ascending: true })
            .limit(1000);
          if (after) q = q.gt('id', after);
          const { data, error } = await q;
          if (error) throw new Error(error.message);
          const batch = (data ?? []) as { id: string; bu: string | null; vertical: string | null }[];
          if (batch.length === 0) break;
          for (const r of batch) {
            const key = `${r.bu ?? 'unknown'}|${r.vertical ?? 'other'}`;
            buckets.set(key, (buckets.get(key) ?? 0) + 1);
          }
          after = batch[batch.length - 1].id;
          if (batch.length < 1000) break;
        }
        const stock = [...buckets.entries()].map(([k, count]) => ({
          bu: k.split('|')[0],
          vertical: k.split('|')[1],
          count,
        }));
        advice = adviseRebalance(
          supply,
          roster.map((r) => ({
            assigneeId: r.id,
            name: r.name,
            bu: r.bu ?? [],
            verticals: r.verticals ?? [],
          })),
          stock
        );
      } catch {
        // No advice is better than advice built on a failed stock read.
      }
    }

    return { rows, supply, advice, unrostered, requireVerified, tableMissing: false };
  } catch {
    return { ...empty, tableMissing: true };
  }
}
