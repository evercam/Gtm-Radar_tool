/**
 * Shared enrichment types. The enrichment layer resolves a raw record
 * (project / tender / filing) to its ACCOUNT (the company behind it) and a set
 * of actionable CONTACTS, using Claude for entity identification + news mining
 * and Apollo for verified contact details. Stateless for now — results are
 * returned inline, not persisted (Supabase accounts/contacts tables come later).
 */

/** The minimal record shape the enrichment endpoint accepts (a normalized search result). */
export interface EnrichInput {
  /** canonical_projects.id — when present (and Supabase is configured) the
   *  enrichment result is persisted back to that row with provenance. */
  id?: string | null;
  canonical_name: string;
  record_type?: string | null;
  icp_code?: string | null;
  company_name_raw?: string | null;
  company_website?: string | null;
  company_domain?: string | null;
  contact_name?: string | null;
  contact_title?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  description?: string | null;
  city?: string | null;
  state_province?: string | null;
  country?: string | null;
  estimated_value?: number | null;
  estimated_value_currency?: string | null;
  source_key?: string | null;
  project_url?: string | null;
  /** Drives which sales play — and therefore which committee — is searched. */
  vertical?: string | null;
  /**
   * Phase and dates, so a brief can say how early we are arriving.
   *
   * Absent before, which meant the call brief could not mention timing at all —
   * and for Evercam timing IS the pitch. "Seven months before ground-breaking"
   * and "already operating" call for opposite conversations, and the brief was
   * being written blind to which one it was.
   *
   * Optional: a caller that omits them gets an `unknown` arrival that says so,
   * rather than a confident guess.
   */
  current_phase?: string | null;
  construction_start_date?: string | null;
  estimated_completion_date?: string | null;
  announced_date?: string | null;
  bid_date?: string | null;
}

export interface RelatedEntity {
  name: string | null;
  role: string | null;
  relationship: string | null; // parent | subsidiary | jv_partner | ...
}
export interface RelatedProject {
  name: string | null;
  location: string | null;
  stage: string | null;
  est_value: number | null;
}

export interface EnrichedAccount {
  /** The company/organization behind the project — the ACCOUNT we sell to. */
  name: string | null;
  domain: string | null;
  website: string | null;
  industry: string | null;
  /** Role in the project: owner / developer / general_contractor / etc. */
  role: string | null;
  hq_location: string | null;
  /** Publicly listed company or site-office number — a way in when no direct dial exists. */
  phone: string | null;
  employee_count: number | null;
  linkedin_url: string | null;
  description: string | null;
  // account-level intelligence (for key-account detection)
  parent_account?: string | null;
  related_entities?: RelatedEntity[];
  related_projects?: RelatedProject[];
  portfolio_value_estimate?: number | null;
  revenue_band?: string | null;
  expansion_signal?: string | null;
  tech_stack?: string[];
}

/** SDR-facing "should I call, when, what do I say" intelligence. */
export interface SdrIntel {
  icp_fit_score: number | null;
  icp_fit_reason: string | null;
  evercam_timing: 'reach_now' | 'watch' | 'too_early' | 'too_late' | null;
  trigger_event: string | null;
  opening_hook: string | null;
  value_angle: 'confidence' | 'evidence' | 'capacity' | null;
  pain_point: string | null;
}

/** Key-account verdict returned to the client. */
export interface KeyAccountResult {
  key_account: boolean;
  key_account_score: number;
  key_account_reasons: string[];
}

export interface EnrichedContact {
  name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  /** Where the contact came from: 'claude' | 'apollo'. */
  source: string;
  /**
   * Apollo's person id, and whether Apollo says an address exists.
   *
   * `api_search` returns neither the email nor the full surname — it reports
   * `has_email` and obfuscates the name ("Ki***a"). Revealing either is a
   * separate, credited `people/match` call, and the id is what that call matches
   * on. Carried here so the reveal step knows which contacts are worth spending
   * a credit on, rather than paying to discover there was nothing to find.
   */
  apolloPersonId?: string | null;
  hasEmail?: boolean;
}

export interface EnrichedNews {
  title: string | null;
  url: string | null;
  summary: string | null;
  published: string | null;
}

export interface EnrichResult {
  ok: boolean;
  account: EnrichedAccount | null;
  contacts: EnrichedContact[];
  news: EnrichedNews[];
  /** Free-text rationale from Claude on how it identified the account. */
  reasoning: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  /** Which engines actually ran. */
  engines: { claude: boolean; apollo: boolean };
  /** Source-personalized account type this run targeted (e.g. "Energy owner / operator"). */
  profile?: string;
  /** SDR call/timing/opener intelligence from Claude. */
  sdr?: SdrIntel | null;
  /** Key-account verdict (rubric-scored from Claude's account findings). */
  keyAccount?: KeyAccountResult | null;
  /** Columns enrichment filled, with which engine created each (source is never overwritten). */
  applied?: { field: string; origin: 'source' | 'claude' | 'apollo' | 'gleif'; value: unknown }[];
  /** True when the result was written back to canonical_projects. */
  persisted?: boolean;
  /**
   * Whether the record now carries the contact channel its lane requires.
   * `satisfied: false` means it was held at PENDING_ENRICHMENT rather than
   * promoted — it is not workable yet.
   */
  channel?: { required: string; satisfied: boolean; missing: string[] } | null;
  message?: string;
  errorKind?: string;
  /** True when this failure will repeat for every remaining record in the batch. */
  fatal?: boolean;
  /** Coverage against the list-quality standard, once contacts are known. */
  coverage?: {
    complete: boolean;
    total: number;
    target: number;
    missing: { role: string; need: number }[];
    /** What was searched and what came back, for the run log. */
    notes?: string[];
  } | null;
  /**
   * What happened when a direct dial was requested. Numbers arrive by webhook
   * minutes later, so without this the run looks like it simply found none.
   */
  phoneReveal?: string | null;
}
