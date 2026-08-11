import { getReadSupabase, getServiceSupabase } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CanonicalProjectRow } from '@/lib/supabase/types';
import { DEFAULT_RULES, route as routeRecord, type RoutingRule, type RoutableRecord } from '@/lib/routing';
import { scorePriority, DEFAULT_PRIORITY_CONFIG, type PriorityConfig, type PriorityVerdict } from '@/lib/priority';
import { configForBu, getEnrichmentPolicy, type ScoringPolicySet } from '@/lib/policies';
import { recordReachable } from '@/lib/export/reachability';
import { arrivalFor } from '@/lib/arrival';
import { PRIORITY_BANDS, ROUTES, STAGES } from '@/lib/semantics';
import { COMPLETENESS_TIER_RANGES } from '@/lib/completeness';

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
  if (error) return []; // table not created yet -> empty state
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

/** Key-account flags per account_key — the account-level half of both passes. */
async function loadAccountSignals(client: SupabaseClient): Promise<Map<string, AccountSignal>> {
  const map = new Map<string, AccountSignal>();
  for (let from = 0; from < 500_000; from += 1000) {
    // Ordered for the same reason as the scoring pass below: an unordered
    // `.range()` walk can repeat rows and skip others, which here would silently
    // drop key-account flags for part of the book.
    const { data, error } = await client
      .from('account_enrichment')
      .select('account_key, key_account, key_account_score')
      .order('account_key', { ascending: true })
      .range(from, from + 999);
    if (error) break;
    for (const r of (data ?? []) as ({ account_key: string } & AccountSignal)[]) map.set(r.account_key, r);
    if (!data || data.length < 1000) break;
  }
  return map;
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
}> {
  const scope = opts.scope ?? 'unscored';
  const maxRecords = opts.maxRecords ?? Infinity;
  const service = getServiceSupabase();
  const signals = await loadAccountSignals(service);
  const nowMs = Date.now();

  // group record ids by outcome signature (disposition + priority)
  const groups = new Map<string, string[]>();
  const byLane: Record<string, number> = {};
  const byBand: Record<string, number> = {};
  let total = 0;

  for (let from = 0; from < 1_000_000; from += 1000) {
    // ORDER BY is not decoration here. Each `.range()` is its own query, so
    // without a stable sort Postgres may return rows in a different order per
    // page — pages then overlap and others are never seen. That is why a pass
    // reporting "22,438 records" left 8,555 with a null band: it counted rows
    // READ, duplicates included, not distinct rows covered. `id` is unique and
    // indexed, which is all a keyset-stable page needs.
    let page = service
      .from('canonical_projects')
      .select(SCORING_COLUMNS)
      .order('id', { ascending: true });
    // Unscored-only reads shrink as the backlog clears, so a daily run costs
    // roughly what arrived that day.
    if (scope === 'unscored') page = page.is('scored_at', null);

    const { data, error } = await page.range(from, from + 999);
    if (error) break;
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
  return { total, byLane, byBand, scope, reachedCap: total >= maxRecords };
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
    const signals = await loadAccountSignals(supabase);
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
      if (error) return empty;
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
    };
  } catch {
    return empty;
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
export type RecordSort = 'priority' | 'newest' | 'value' | 'exported';
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

  const run = async (tier: ColumnTier) => {
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
    if (q.sort === 'value') query = query.order('estimated_value', { ascending: false, nullsFirst: false });
    // Most recently handed over first, and never a null export date at the top:
    // this sort exists to audit what was sent, so a page of unexported records
    // above the newest handover would defeat the only reason to pick it.
    else if (q.sort === 'exported')
      query = query
        .order('apollo_exported_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });
    else if (q.sort === 'newest' || !hasPriority) query = query.order('created_at', { ascending: false });
    else
      query = query
        .order('priority_score', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });

    return query.range(from, from + pageSize - 1);
  };

  const tiers: ColumnTier[] = ['full', 'routing', 'core'];
  for (const tier of tiers) {
    const { data, error, count } = await run(tier);
    if (!error) return { rows: (data ?? []) as unknown as RecordRow[], total: count ?? 0 };
    if (!isMissingColumn(error)) break;
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
  const PAGE = 1000;
  for (let from = 0; from < 500_000; from += PAGE) {
    const { data, error } = await supabase
      .from('canonical_projects')
      .select('source_key, population_percentage, created_at')
      // Ordered, because an unordered `.range()` walk repeats and skips rows —
      // here it would misreport how much each source has actually contributed.
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return {};
    for (const r of (data ?? []) as {
      source_key: string;
      population_percentage: number | null;
      created_at: string;
    }[]) {
      const a = (agg[r.source_key] ??= { count: 0, sum: 0, last: null });
      a.count += 1;
      a.sum += Number(r.population_percentage) || 0;
      if (!a.last || r.created_at > a.last) a.last = r.created_at;
    }
    if (!data || data.length < PAGE) break;
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

export async function getPipelineRollup(): Promise<PipelineRollupRow[]> {
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

  /*
    Coverage, from the roster rather than from the leads. An assignee with an
    EMPTY bu list is unrestricted on that axis and therefore covers every BU —
    reading empty as "covers nothing" would report the whole book as stranded.
  */
  try {
    const { data } = await supabase.from('assignees').select('bu, is_active').eq('is_active', true);
    const active = (data ?? []) as { bu: string[] | null }[];
    for (const row of acc.values()) {
      row.activeAssignees = active.filter((a) => !a.bu?.length || a.bu.includes(row.bu)).length;
    }
  } catch {
    // Leave the counts at zero rather than inventing coverage.
  }

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
export async function getDispositionRollup(): Promise<DispositionRollup> {
  const supabase = await getReadSupabase();

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
  const countWhere = async (filters: CountFilter[] = []): Promise<number | null> => {
    let q = supabase.from('canonical_projects').select('id', { count: 'exact', head: true });
    for (const f of filters) {
      q = f.op === 'eq' ? q.eq(f.column, f.value) : q.not(f.column, 'is', null);
    }
    const { count, error } = await q;
    if (error) return null;
    return count ?? 0;
  };

  // Routing columns arrived in a later migration than the priority ones, so the
  // dashboard degrades to bands-only rather than showing nothing.
  let routingMissing = false;

  const [total, scored, routed] = await Promise.all([
    countWhere(),
    countWhere([{ column: 'priority_band', op: 'notNull' }]),
    countWhere([{ column: 'route', op: 'notNull' }]),
  ]);
  if (routed === null) routingMissing = true;

  const [bandCounts, laneCounts, tierCounts, lastRouted] = await Promise.all([
    Promise.all(
      PRIORITY_BANDS.map(async (band) => ({
        band,
        count: (await countWhere([{ column: 'priority_band', op: 'eq', value: band }])) ?? 0,
      }))
    ),
    routingMissing
      ? Promise.resolve([])
      : Promise.all(
          ROUTES.flatMap((route) =>
            STAGES.map(async (stage) => ({
              route,
              stage,
              count:
                (await countWhere([
                  { column: 'route', op: 'eq', value: route },
                  { column: 'stage', op: 'eq', value: stage },
                ])) ?? 0,
            }))
          )
        ),
    Promise.all(
      COMPLETENESS_TIERS.map(async (tier) => ({
        tier,
        count: (await countWhere([{ column: 'source_completeness_tier', op: 'eq', value: tier }])) ?? 0,
      }))
    ),
    // The most recent routing stamp, as one ordered row rather than a scan for a max.
    (async () => {
      const { data, error } = await supabase
        .from('canonical_projects')
        .select('routed_at')
        .not('routed_at', 'is', null)
        .order('routed_at', { ascending: false })
        .limit(1);
      if (error) return null;
      return ((data ?? [])[0] as { routed_at?: string } | undefined)?.routed_at ?? null;
    })(),
  ]);

  const tiered = tierCounts.reduce((sum, t) => sum + t.count, 0);

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
    // Derived rather than counted: anything with no tier is the remainder, which
    // also means an unrecognised tier value cannot go missing from the total.
    untiered: Math.max(0, (total ?? 0) - tiered),
    routingMissing,
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
  /** Days of cover `ready` represents at the roster's draw rate. */
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
      supabase.from('assignees').select('daily_lead_quota').eq('is_active', true),
    ]);

  const dailyDemand = (roster ?? []).reduce(
    (n, r) => n + ((r as { daily_lead_quota: number | null }).daily_lead_quota ?? 0),
    0
  );
  const readyCount = ready ?? 0;
  const daysOfCover = dailyDemand > 0 ? Math.round((readyCount / dailyDemand) * 10) / 10 : 0;

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
    daysOfCover,
    remaining,
    reason,
  };
}

/**
 * The enrichment queue: records eligible under the policy, highest priority
 * first. This is the exact selection the batch endpoint processes, so the
 * control centre can show the queue before spending anything on it.
 */
export async function getEnrichmentQueue(
  f: EnrichQueueFilters = {}
): Promise<{ rows: EnrichQueueRow[]; total: number; unreachableSkipped: number }> {
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

  const run = async (withStatus: boolean) => {
    const columns = withStatus ? `${ENRICH_QUEUE_COLUMNS},status` : ENRICH_QUEUE_COLUMNS;
    const base = supabase.from('canonical_projects').select(columns, { count: 'exact' });
    const filters = withStatus ? { ...f, statuses: f.statuses ?? CLAIMABLE_STATUSES } : { ...f, statuses: undefined };
    const query = applyQueueFilters(base as never, filters) as unknown as typeof base;
    return query.order('priority_score', { ascending: false, nullsFirst: false }).limit(overfetch);
  };

  try {
    // Prefer the lifecycle-aware query; fall back to the pre-lifecycle shape
    // when that migration hasn't run, so the queue still works rather than
    // silently reporting zero eligible records.
    let { data, error, count } = await run(true);
    if (isMissingColumn(error)) ({ data, error, count } = await run(false));
    if (error) return { rows: [], total: 0, unreachableSkipped: 0 };

    const fetched = (data ?? []) as unknown as EnrichQueueRow[];
    if (f.includeUnreachable) return { rows: fetched.slice(0, want), total: count ?? 0, unreachableSkipped: 0 };

    /**
     * Drop the projects that are already built, cancelled or commissioning.
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
    const keep = fetched.filter((r) => arrivalFor(r).verdict !== 'too_late');
    return {
      rows: keep.slice(0, want),
      total: count ?? 0,
      // Only what was seen on this page. The database count is unfiltered, and
      // extrapolating a global figure from a sample would be a guess presented
      // as a number.
      unreachableSkipped: fetched.length - keep.length,
    };
  } catch {
    return { rows: [], total: 0, unreachableSkipped: 0 };
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
export async function getEnrichedSinceCount(days: number): Promise<number> {
  const supabase = await getReadSupabase();
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
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
  const empty: HandoverBreakdown = { rows: [], unrostered: 0, requireVerified: false, tableMissing: false };
  try {
    const service = getServiceSupabase();
    const { config: policy } = await getEnrichmentPolicy();
    const requireVerified = policy.requireChannel;

    const { data: rosterRows, error: rosterError } = await service
      .from('assignees')
      .select('id, name, is_active, daily_lead_quota');
    if (rosterError) {
      return { ...empty, tableMissing: /does not exist|schema cache|relation/i.test(rosterError.message) };
    }
    const roster = (rosterRows ?? []) as { id: string; name: string; is_active: boolean; daily_lead_quota: number | null }[];

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

    return { rows, unrostered, requireVerified, tableMissing: false };
  } catch {
    return { ...empty, tableMissing: true };
  }
}
