import type { CriticalField, CompletenessTierCode, RecordType, BusinessUnit } from '@/lib/supabase/types';

/** Loosely-typed raw payload as returned by a vendor API, prior to normalization. */
export type RawProjectRecord = Record<string, unknown>;

/**
 * The subset of `canonical_projects` columns an adapter's normalize() step
 * is responsible for producing. `id`, `created_at`, `updated_at` are left to
 * Postgres defaults; the ingest route supplies `source_key` alongside this
 * on upsert.
 */
export interface CanonicalProjectInsert {
  canonical_name: string;
  source_key: string;
  source_unique_id: string;
  icp_code: string | null;
  record_type: RecordType;
  bu: BusinessUnit;
  project_type?: string | null;
  building_type?: string | null;
  description?: string | null;
  square_footage?: number | null;
  number_of_floors?: number | null;
  /**
   * Megawatts. Only ever MW — a source measuring throughput or tonnage must
   * leave this null and put the native figure in `description`, or the column
   * stops meaning anything and value-sorted lists rank a pipeline's 120,000
   * barrels/day above a 265 MW power station.
   */
  capacity_mw?: number | null;
  /** Reactor type, fuel, panel technology — whatever the source calls its kind. */
  technology_type?: string | null;
  is_remote_location?: boolean;
  is_access_constrained?: boolean;
  address_line1?: string | null;
  city?: string | null;
  state_province?: string | null;
  country?: string | null;
  country_code?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  announced_date?: string | null;
  construction_start_date?: string | null;
  estimated_completion_date?: string | null;
  bid_date?: string | null;
  project_url?: string | null;
  current_phase?: string | null;
  estimated_value?: number | null;
  estimated_value_currency?: string | null;
  company_name_raw?: string | null;
  company_website?: string | null;
  company_domain?: string | null;
  contact_name?: string | null;
  contact_title?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  contact_linkedin_url?: string | null;
  /** column -> origin ('source'|'claude'|'apollo'|'gleif'); set to 'source' at save time. */
  field_provenance?: Record<string, string>;
  /** normalized company identity (set on account import + by enrichment). */
  account_key?: string | null;
  /**
   * Owner grouping, prefixed with its provenance: `E:<id>` from a
   * source-published owner identifier, `N:<slug>` from the owner's name.
   *
   * Set by the adapter and never by enrichment, which is what makes it stable
   * enough to group by — unlike `account_key`, which enrichment rewrites each
   * run. See migration 20260730120000.
   */
  owner_group_key?: string | null;
  source_completeness_tier: CompletenessTierCode;
  source_completeness_score: number;
  fields_populated: Partial<Record<CriticalField, boolean>>;
  fields_missing: CriticalField[];
  population_percentage: number;
  processing_status: 'normalized';
  raw_data: RawProjectRecord;
}

/**
 * Params accepted by fetchRawProjects — a superset any adapter may ignore
 * fields of. `since`/`until`/`page`/`pageSize` apply server-side for both
 * live adapters. The rest map to each vendor's REAL, confirmed filter
 * capabilities (not generic guesses):
 *   - Barbour ABI applies `minValue`/`keyword`/`postcodes` server-side, as
 *     AND-combined conditions in its `query` param (see barbour-abi.ts).
 *   - Glenigan's `/project/newproject` endpoint has no server-side sector/
 *     region/value filtering (confirmed: only Page/Size/OrderBy/TimeRange are
 *     accepted), so `minValue`/`sectors`/`regions`/`keyword` are applied
 *     client-side after fetching a page (see glenigan.ts) — the same
 *     approach used by the reference adapter this was ported from.
 */
export interface AdapterFetchParams {
  /**
   * Terms to ask the publisher for, rather than pulling the newest rows and
   * hoping the vertical turns up.
   *
   * Measured on Chicago building permits: the newest 10,000 rows contained THREE
   * records mentioning a data centre; a server-side LIKE on the same dataset
   * returned 175 across all history. Bulk ingest is dominated by routine small
   * works because that is what most permits are, so a book that is thin on a
   * vertical should ask for it by name.
   *
   * Only honoured by adapters whose publisher supports a text filter.
   */
  focusTerms?: string[];

  since?: Date;
  until?: Date;
  page?: number;
  /**
   * Records per HTTP request — the vendor's own page size, nothing more.
   *
   * It used to mean both this AND the total to return, which is why every source
   * fetched exactly 50: the route passed `pageSize: 50`, the adapter stopped
   * paginating at 50 records and then sliced to 50. `max_records_per_run` was
   * 500, read from the config, and never applied. Set this to whatever the vendor
   * documents as its maximum — a request for 250 costs the same as one for 50.
   */
  pageSize?: number;
  /**
   * Total records this run may return, across however many pages that takes.
   *
   * The run's budget, from `source_config.max_records_per_run`. Absent means
   * "one page and stop", which keeps a caller that has not been updated behaving
   * exactly as before rather than suddenly paginating without being asked.
   */
  maxRecords?: number;
  /** When true, adapters should fetch at most one small page and not paginate exhaustively. */
  dryRun?: boolean;
  /** Minimum project value in GBP. */
  minValue?: number;
  /** Free-text match against project title/description. */
  keyword?: string;
  /** Barbour ABI only: exact postcode match, OR'd together. */
  postcodes?: string[];
  /** Glenigan only: substring match against PrimarySectors/SecondarySectors. */
  sectors?: string[];
  /** Glenigan only: substring match against town/county/region. */
  regions?: string[];
  /**
   * news-search only: which ICP hunts to run, by icp_code or by vertical.
   *
   * Reuses the saved-query UI's existing vertical field rather than adding a
   * parameter nobody can set — asking for "just the data-centre owners" is the
   * same intent expressed either way. Omitted means every ICP.
   */
  verticals?: string[];
  /** SEC EDGAR only: filing form types (e.g. ["8-K","10-K"]) — server-side `forms` param. */
  forms?: string[];
  /**
   * UK OCDS feeds (find-a-tender, contracts-finder): which point in the
   * procurement lifecycle to return.
   *
   *   planning  an intention to buy, before anything is out to market
   *   tender    open right now — still biddable
   *   award     a contractor has been chosen
   *
   * Omit for every stage. The publishers accept only ONE value: a comma list
   * such as "tender,award" is accepted and returns zero results, which is why
   * this is a single choice rather than a set.
   */
  stage?: 'planning' | 'tender' | 'award';
  /**
   * OCDS procurement feeds (find-a-tender, austender, contracts-finder) only:
   * keep only construction/engineering notices (by CPV/UNSPSC classification,
   * with a keyword fallback). Defaults to TRUE — these are general-procurement
   * publishers, so a construction lead tool wants them construction-scoped.
   * Pass false to return every procurement category.
   */
  constructionOnly?: boolean;
  /**
   * UK OCDS feeds only: keep only NHS/health-body construction and estates work.
   *
   * REPLACES `constructionOnly` rather than narrowing it. The generic construction
   * vocabulary is wrong in both directions on health procurement — it admits
   * "Microsoft Infrastructure Software Licensing" and drops "Asbestos Abatement" —
   * so running both filters would discard genuine leads. See `@/lib/healthInfra`.
   */
  healthInfraOnly?: boolean;
  /**
   * GEM only: keep only records whose geography-derived business unit is in
   * this list (values: "usa" | "uk" | "ireland" | "apac" | "export",
   * case-insensitive). Empty/omitted returns all BUs.
   */
  businessUnits?: string[];
  /**
   * Per-request credential override, supplied by the no-persistence Search UI
   * so a key can be used for a one-off query WITHOUT being saved to the DB or
   * env. Takes priority over resolveCredentials()'s DB/env lookup. Any field
   * left blank falls back to the resolved value.
   */
  credentials?: {
    apiKey?: string;
    apiSecret?: string;
    username?: string;
    baseUrl?: string;
  };
}

export interface SourceAdapter {
  sourceKey: string;
  /**
   * Whether credentials are available — checks the `source_credentials` DB
   * row first, then falls back to env vars. Async because the DB check is
   * async (see `src/lib/adapters/credentials.ts`).
   */
  isConfigured(): Promise<boolean>;
  /** Fetch raw vendor project records, handling pagination/retry internally. */
  fetchRawProjects(params?: AdapterFetchParams): Promise<RawProjectRecord[]>;
  /** Map one raw vendor record to the canonical_projects insert shape. */
  normalize(raw: RawProjectRecord): CanonicalProjectInsert;
}

export class AdapterAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterAuthError';
  }
}

export class AdapterNetworkError extends Error {
  constructor(
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = 'AdapterNetworkError';
  }
}

export class AdapterShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterShapeError';
  }
}

/**
 * fetch() wrapper with a timeout and retry-with-backoff (max 3 attempts) on
 * network errors. Does NOT retry on 401/403 (auth errors surface immediately
 * so the caller can distinguish "bad key" from "network flake").
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { timeoutMs?: number; maxAttempts?: number } = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxAttempts = opts.maxAttempts ?? 3;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 401 || res.status === 403) {
        throw new AdapterAuthError(`Authentication failed (HTTP ${res.status}) calling ${url}`);
      }
      // 429 is how every provider we pull from signals throttling, and several
      // document a Retry-After alongside it. Treating it as a plain failure
      // meant one throttled page aborted the whole ingest, so honour the wait
      // the provider asked for instead of guessing.
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        await backoff(attempt, res.headers.get('retry-after'));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof AdapterAuthError) throw err;
      lastError = err;
      if (attempt < maxAttempts) {
        await backoff(attempt);
        continue;
      }
    }
  }
  throw new AdapterNetworkError(
    `Request to ${url} failed after ${maxAttempts} attempts: ${String(lastError)}`,
    lastError
  );
}

/** Longest we will sit on a Retry-After before giving the run back. */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Seconds, or an HTTP-date, per RFC 9110. Anything else — or a wait longer
 * than a run can reasonably absorb — falls back to exponential backoff.
 */
export function parseRetryAfter(header: string | null, nowMs: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return ms >= 0 && ms <= MAX_RETRY_AFTER_MS ? ms : null;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const ms = at - nowMs;
  return ms > 0 && ms <= MAX_RETRY_AFTER_MS ? ms : null;
}

function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
  const asked = parseRetryAfter(retryAfter ?? null);
  const delayMs = asked ?? 250 * 2 ** (attempt - 1); // 250ms, 500ms, 1000ms...
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
