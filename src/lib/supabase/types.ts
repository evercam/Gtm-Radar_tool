// Minimal hand-written row types for the four tables in supabase_setup.sql.
// Kept intentionally loose (no generated `Database` type) since this project
// does not run `supabase gen types` against a live project.

export type IcpTier = 'strategic' | 'enterprise' | 'inbound' | 'light_touch';
export type Pillar = 'confidence' | 'evidence' | 'capacity';

export interface IcpDefinitionRow {
  id: string;
  icp_code: string;
  icp_label: string;
  icp_tier: IcpTier;
  lead_pillar: Pillar;
  second_pillar: Pillar | null;
  third_pillar: Pillar | null;
  why_message: string;
  what_message: string;
  how_message: string;
  now_question: string;
  language_to_use: string[];
  language_to_avoid: string[];
  brand_bridge: string;
  qualification_threshold: number;
  sdr_response_sla_hours: number;
  target_sectors: string[];
  confidence_weight: number;
  evidence_weight: number;
  capacity_weight: number;
  is_outbound_target: boolean;
  requires_abm: boolean;
  is_global_icp: boolean;
  created_at: string;
  updated_at: string;
}

export type CompletenessTierCode = 'A' | 'B' | 'C' | 'D' | 'E';
export type EnrichmentPriority = 'critical' | 'high' | 'medium' | 'low' | 'none';

export interface DataCompletenessTierRow {
  id: string;
  tier_code: CompletenessTierCode;
  tier_label: string;
  min_score: number;
  max_score: number;
  description: string;
  requires_immediate_enrichment: boolean;
  enrichment_priority: EnrichmentPriority | null;
  created_at: string;
}

export type ApiType = 'rest' | 'graphql' | 'rss' | 'ftp' | 'webhook' | 'csv_upload' | 'web_scraping';
export type AuthType = 'api_key' | 'oauth2' | 'basic_auth' | 'none' | 'ip_whitelist' | 'proxy';
export type DataFormat = 'json' | 'xml' | 'csv' | 'html' | 'geojson' | 'rss';
export type SignalStrength = 'strong' | 'medium' | 'weak';
export type DataFreshness = 'real_time' | 'daily' | 'weekly' | 'monthly' | 'quarterly';
export type HealthStatus = 'healthy' | 'degraded' | 'failing' | 'disabled' | 'unconfigured';

export type PrimaryDataCategory =
  | 'project_announcement'
  | 'permit_filing'
  | 'company_profile'
  | 'contact_information'
  | 'financial_data'
  | 'regulatory_filing'
  | 'construction_phase'
  | 'technology_adoption'
  | 'funding_event'
  | 'market_trend'
  | 'competitor_intelligence'
  | 'geographic_data'
  | 'energy_project'
  | 'public_procurement'
  | 'property_intelligence';

/**
 * Business Unit that owns a lead. Deterministic per source. 'export' is the
 * Major Projects / Export business — complex, mission-critical, geo-politically
 * important projects delivered across regions.
 */
export type BusinessUnit = 'usa' | 'uk' | 'ireland' | 'apac' | 'export';

/** What kind of record a canonical_projects row represents (independent of ICP). */
export type RecordType = 'project' | 'tender' | 'permit' | 'filing' | 'news' | 'account' | 'contact' | 'signal';

/** The 12 critical lead fields used to compute data completeness scores. */
export type CriticalField =
  | 'project_name'
  | 'project_value'
  | 'project_location'
  | 'project_timeline'
  | 'building_type'
  | 'company_name'
  | 'company_contact'
  | 'project_phase'
  | 'square_footage'
  | 'funding_source'
  | 'company_website'
  | 'company_phone';

export interface SourceRegistryRow {
  id: string;
  source_name: string;
  source_key: string;
  api_type: ApiType | null;
  api_endpoint: string | null;
  auth_type: AuthType | null;
  data_format: DataFormat | null;
  icp_code: string;
  is_exclusive: boolean;
  primary_data_category: PrimaryDataCategory;
  what_it_detects: string;
  signal_strength: SignalStrength | null;
  completeness_tier: CompletenessTierCode;
  completeness_score: number;
  fields_provided: CriticalField[];
  fields_missing: CriticalField[];
  requires_enrichment: boolean;
  enrichment_gap_score: number;
  recommended_enrichment_sources: string[];
  overall_priority_score: number | null;
  priority_rank: number | null;
  coverage_countries: string[];
  coverage_regions: string[];
  data_freshness: DataFreshness | null;
  normalization_mapping: Record<string, unknown>;
  enrichment_pipeline: string[];
  fetch_schedule: string | null;
  is_active: boolean;
  is_configured: boolean;
  is_premium: boolean;
  health_status: HealthStatus;
  last_successful_fetch: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export type ProcessingStatus =
  'ingested' | 'normalized' | 'enriching' | 'enriched' | 'scored' | 'qualified' | 'routed' | 'failed' | 'duplicate';

export interface CanonicalProjectRow {
  id: string;
  canonical_name: string;
  source_key: string;
  source_unique_id: string;
  icp_code: string | null;
  record_type: RecordType;
  bu: BusinessUnit;
  project_type: string | null;
  building_type: string | null;
  description: string | null;
  square_footage: number | null;
  number_of_floors: number | null;
  capacity_mw: number | null;
  technology_type: string | null;
  address_line1: string | null;
  city: string | null;
  state_province: string | null;
  country: string | null;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  is_remote_location: boolean;
  is_access_constrained: boolean;
  announced_date: string | null;
  construction_start_date: string | null;
  estimated_completion_date: string | null;
  bid_date: string | null;
  project_url: string | null;
  current_phase: string | null;
  estimated_value: number | null;
  estimated_value_currency: string;
  company_name_raw: string | null;
  company_id: string | null;
  contact_name: string | null;
  contact_title: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  source_completeness_tier: CompletenessTierCode | null;
  source_completeness_score: number | null;
  fields_populated: Record<string, unknown>;
  fields_missing: CriticalField[];
  population_percentage: number | null;
  enriched_completeness_tier: CompletenessTierCode | null;
  enriched_completeness_score: number | null;
  enrichment_gap_closed_percentage: number | null;
  confidence_score: number | null;
  evidence_score: number | null;
  capacity_score: number | null;
  composite_score: number | null;
  processing_status: ProcessingStatus;
  raw_data: Record<string, unknown> | null;
  enrichment_jobs: unknown[];
  created_at: string;
  updated_at: string;
  // Derived/generated by the DB (migration 20260725133258) — read-only, never
  // inserted. See supabase/migrations for the rules.
  vertical: string;
  contact_status: 'has_contact' | 'needs_enrichment';
  ref_code: string;
  org_path: string;
  // provenance (migration 20260725133259)
  company_website: string | null;
  company_domain: string | null;
  field_provenance: Record<string, 'source' | 'claude' | 'apollo'>;
  // SDR intelligence + account key (migration 20260725133260)
  icp_fit_score: number | null;
  icp_fit_reason: string | null;
  evercam_timing: 'reach_now' | 'watch' | 'too_early' | 'too_late' | null;
  trigger_event: string | null;
  opening_hook: string | null;
  value_angle: 'confidence' | 'evidence' | 'capacity' | null;
  pain_point: string | null;
  account_key: string | null;
  /**
   * Owner grouping (migration 20260730120000). `E:<id>` from a source-published
   * owner identifier, `N:<slug>` from the owner's name — the prefix is how a
   * caller tells an exact grouping from a best-effort one. Set at ingest and by
   * `scripts/resolve-owner-groups.mjs`; never by enrichment.
   */
  owner_group_key: string | null;

  /**
   * Apollo handover. `apollo_exported_at` is the archive flag: once set, the
   * lead has left the working list and is never re-enriched, re-exported or
   * counted as ready stock. Stamped only on a SUCCESSFUL send, so a failure
   * leaves the lead eligible for the next run rather than silently dropping it —
   * which is why `apollo_export_status` can read 'failed' while
   * `apollo_exported_at` is still null.
   */
  apollo_exported_at: string | null;
  apollo_contact_id: string | null;
  apollo_export_status: string | null;
  apollo_export_error: string | null;

  /**
   * Contact verification (migration 20260726150000).
   *
   * `*_verified` false with a `*_validation_source` set means a validator ran and
   * was not satisfied; false with a NULL source means nothing ever checked. The
   * difference matters once leads are allowed to export unverified — an
   * unconfirmed address must not read like a confirmed one.
   */
  email_verified: boolean;
  email_confidence: number | null;
  email_validation_source: string | null;
  /*
    Why the contact on this row is the one to call. Written by the enrichment
    ranking; see lib/enrich/contactMatch.ts. All nullable, because every record
    enriched before the matcher existed has no verdict — and "never judged" must
    stay distinguishable from "judged and found unknown".
  */
  contact_state: string | null;
  /** same_state | nearby | distant | unknown — `unknown` is not a synonym for distant. */
  contact_geo_match: string | null;
  /** current | left | unknown. `left` never survives to become the primary. */
  contact_employment_status: string | null;
  contact_job_change_signal: string | null;
  contact_match_score: number | null;
  contact_match_reasons: string[] | null;
  contact_match_confidence: string | null;
  phone_verified: boolean;
  phone_confidence: number | null;
  phone_type: string | null;
  phone_validation_source: string | null;
}
