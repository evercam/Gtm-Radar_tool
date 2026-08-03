/**
 * What each vendor's API actually permits — one place, read by everything.
 *
 * Three consumers need these numbers and they must not disagree: the adapters
 * (which must not ask for more than a vendor accepts), the Source Hub (which
 * should not offer a page size the vendor will reject), and the help page (which
 * explains the reasoning). Kept apart in three files, they would drift, and the
 * first symptom would be a source silently truncating.
 *
 * VERIFIED means read in the vendor's own documentation, with the link. ASSUMED
 * means it is what our adapter happens to do and nobody has checked. The
 * distinction is load-bearing: an assumed limit is a guess with a number on it,
 * and tuning against one is how you get throttled or truncated. Never promote an
 * entry to verified without reading the docs and putting the URL here.
 *
 * The gap this exists to close: Socrata permits fifty thousand records in one
 * request and our adapter was asking for two hundred, while the stored config
 * capped it at fifty. Nothing in the tool showed the difference.
 */

export interface ApiLimit {
  /** source_config.slug this applies to. */
  slugs: string[];
  label: string;
  /** Most records one request may return. */
  maxPerRequest: number;
  /** A sane page size for us — below the vendor max where a huge payload is unwise. */
  recommendedPageSize: number;
  /** How the vendor wants you to walk pages. */
  paging: 'page' | 'offset' | 'cursor' | 'links.next';
  /**
   * Hard ceiling on the TOTAL result set, however patiently you page. The one
   * people miss — no page size gets past it, only a narrower query.
   */
  maxTotalResults: number | null;
  /** Longest date span one query may cover, in days. */
  maxDateSpanDays: number | null;
  /** Requests per minute we should stay under, where documented. */
  requestsPerMinute: number | null;
  /**
   * How you have to approach it, which matters more than any single number.
   *
   * deep      page as far as you like; the only cost is requests
   * capped    a hard total-result ceiling — the only way past it is a narrower
   *           query, usually a date window, stitched together
   * windowed  the query itself may not span more than a fixed period
   * cursor    follow the publisher's own next-link; depth is theirs to decide
   * contract  a commercial feed, where the limit is billing rather than HTTP
   */
  strategy: 'deep' | 'capped' | 'windowed' | 'cursor' | 'contract';
  /** Records the whole source holds, where it publishes a count. */
  totalAvailable?: number;
  verified: boolean;
  /** Required when verified is true. */
  doc?: string;
  /** What a caller most needs to know that the numbers alone do not say. */
  note: string;
}

export const API_LIMITS: ApiLimit[] = [
  {
    slugs: ['nyc-permits', 'chicago-permits'],
    label: 'Socrata (NYC + Chicago permits)',
    maxPerRequest: 50_000,
    // Far below their maximum on purpose: fifty thousand rows is a very large
    // response to hold in memory and parse inside a serverless function, and the
    // gain over two thousand is not worth the risk of one request timing out.
    recommendedPageSize: 2_000,
    paging: 'offset',
    maxTotalResults: null,
    maxDateSpanDays: null,
    requestsPerMinute: 16,
    strategy: 'deep',
    verified: true,
    doc: 'https://dev.socrata.com/docs/app-tokens.html',
    note: 'A free app token raises throttling to 1,000 requests an hour — about 16 a minute. Without one it is much lower and undocumented.',
  },
  {
    slugs: ['sam-gov'],
    label: 'SAM.gov opportunities',
    maxPerRequest: 1_000,
    recommendedPageSize: 1_000,
    paging: 'offset',
    maxTotalResults: null,
    maxDateSpanDays: 365,
    requestsPerMinute: null,
    strategy: 'windowed',
    verified: true,
    doc: 'https://open.gsa.gov/api/get-opportunities-public-api/',
    note: 'Both date bounds are mandatory and the span may not exceed one year — a longer window is rejected outright, not truncated.',
  },
  {
    slugs: ['sec-edgar'],
    label: 'SEC EDGAR full-text search',
    maxPerRequest: 100,
    recommendedPageSize: 100,
    paging: 'offset',
    // The trap. Past 10,000 it answers HTTP 200 with an error object in the body,
    // so a naive caller reads success and gets nothing.
    maxTotalResults: 10_000,
    maxDateSpanDays: null,
    requestsPerMinute: 600,
    strategy: 'capped',
    verified: true,
    doc: 'https://www.sec.gov/edgar/search/efts-faq.html',
    note: 'Page size is fixed at 100 — no size parameter is honoured. The total window is 10,000 hits, so paging past it fails with HTTP 200 and an error body. Ten requests a second, and a User-Agent identifying the caller is required.',
  },
  {
    slugs: ['find-a-tender', 'contracts-finder'],
    label: 'OCDS feeds (Find a Tender, Contracts Finder)',
    maxPerRequest: 100,
    recommendedPageSize: 100,
    paging: 'links.next',
    maxTotalResults: null,
    maxDateSpanDays: null,
    requestsPerMinute: null,
    strategy: 'cursor',
    verified: true,
    doc: 'https://standard.open-contracting.org/latest/en/guidance/build/hosting/',
    note: 'The standard sets no page limit — it is the publisher’s choice, and Contracts Finder documents no numbers at all. It does prefer a cursor over an offset, because with offsets "a given page won’t return the same results over time".',
  },
  {
    slugs: ['ted'],
    label: 'TED (EU tenders)',
    maxPerRequest: 250,
    recommendedPageSize: 250,
    paging: 'page',
    maxTotalResults: null,
    maxDateSpanDays: null,
    requestsPerMinute: null,
    strategy: 'deep',
    verified: false,
    note: 'Rejects sort parameters, and returns oldest-first inside whatever window it is given — so an unbounded query answers from 2016 rather than from today. Our adapter therefore always sends a date window.',
  },
  {
    slugs: ['usaspending'],
    label: 'USAspending',
    maxPerRequest: 100,
    recommendedPageSize: 100,
    paging: 'page',
    // Same trap as EDGAR: the paginated search tops out around here whatever the
    // filters say. Their bulk-download endpoint is the way past it, not more pages.
    maxTotalResults: 10_000,
    maxDateSpanDays: null,
    requestsPerMinute: null,
    strategy: 'capped',
    verified: true,
    doc: 'https://api.usaspending.gov/docs/',
    note: 'Page size is capped at 100 and the paginated search tops out at roughly 10,000 records per query. Past that, narrow the filters or use their bulk download endpoint — more pages will not help.',
  },
  {
    slugs: ['world-bank'],
    label: 'World Bank projects',
    // Probed directly: rows=1000 returns 1000, rows=5000 also returns 1000.
    // Our adapter was asking for twenty, a fiftieth of what is on offer.
    maxPerRequest: 1_000,
    recommendedPageSize: 1_000,
    paging: 'offset',
    maxTotalResults: null,
    maxDateSpanDays: null,
    requestsPerMinute: null,
    strategy: 'deep',
    totalAvailable: 28_066,
    verified: true,
    doc: 'https://search.worldbank.org/api/v3/projects?format=json&rows=10',
    note: 'The `rows` parameter silently clamps at 1,000 — asking for more returns exactly a thousand rather than an error. The response carries a total, currently about 28,000 projects, and offset paging walks all of them.',
  },
  {
    slugs: ['planning-ie'],
    label: 'Planning.ie (ArcGIS)',
    // The service declares its own limits, so there is no need to guess:
    // maxRecordCount 2000, standardMaxRecordCount 16000, pagination supported.
    maxPerRequest: 2_000,
    recommendedPageSize: 2_000,
    paging: 'offset',
    maxTotalResults: null,
    maxDateSpanDays: null,
    requestsPerMinute: null,
    strategy: 'deep',
    totalAvailable: 500_736,
    verified: true,
    doc: 'https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0?f=json',
    note: 'An ArcGIS layer publishes its own ceilings in its metadata — this one declares maxRecordCount 2,000 and supports pagination, over half a million planning applications. The deepest source we have by a wide margin.',
  },
  {
    slugs: ['glenigan', 'barbour-abi', 'construct-connect'],
    label: 'Commercial feeds (Glenigan, Barbour ABI, ConstructConnect)',
    maxPerRequest: 50,
    recommendedPageSize: 50,
    paging: 'page',
    maxTotalResults: null,
    maxDateSpanDays: null,
    requestsPerMinute: null,
    strategy: 'contract',
    verified: false,
    note: 'Commercial — the limits are in the contract rather than public documentation, and exceeding them is a billing conversation rather than an HTTP error.',
  },
];

const BY_SLUG = new Map<string, ApiLimit>();
for (const l of API_LIMITS) for (const s of l.slugs) BY_SLUG.set(s, l);

/** What we know about this source's API, or null when nothing is recorded. */
export function apiLimitFor(slug: string): ApiLimit | null {
  return BY_SLUG.get(slug) ?? null;
}

/**
 * Page sizes worth offering for this source.
 *
 * Capped at what the vendor accepts, so the Source Hub cannot offer a value that
 * will be rejected — and the recommended size is always present even when it is
 * not one of the round numbers.
 */
export function pageSizeOptions(slug: string): number[] {
  const limit = apiLimitFor(slug);
  const ladder = [10, 25, 50, 100, 200, 500, 1_000, 2_000, 5_000];
  if (!limit) return ladder.filter((n) => n <= 200);
  const allowed = ladder.filter((n) => n <= limit.maxPerRequest);
  if (!allowed.includes(limit.recommendedPageSize)) allowed.push(limit.recommendedPageSize);
  return [...new Set(allowed)].sort((a, b) => a - b);
}

/**
 * A run budget this source can actually deliver.
 *
 * Clamped to the total-results ceiling where one exists, because asking EDGAR for
 * 20,000 does not fetch 20,000 — it pages happily to 10,000 and then starts
 * getting HTTP 200 responses with error bodies in them.
 */
export function clampRunBudget(slug: string, requested: number): number {
  const limit = apiLimitFor(slug);
  if (!limit?.maxTotalResults) return requested;
  return Math.min(requested, limit.maxTotalResults);
}
