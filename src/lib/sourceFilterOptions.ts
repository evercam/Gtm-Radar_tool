// Central enum lists mirrored from the CHECK constraints in supabase_setup.sql,
// used to render every filter control on /sources.

export const ICP_OPTIONS = [
  { value: 'mission_critical_owner', label: 'Mission-Critical Asset Owners' },
  { value: 'critical_infra_owner', label: 'Critical Infrastructure Owners' },
  { value: 'tier1_gc', label: 'Tier 1 General Contractors' },
  { value: 'tier2_gc', label: 'Tier 2 General Contractors' },
  { value: 'developer', label: 'Developers' },
];

export const COMPLETENESS_TIER_OPTIONS = ['A', 'B', 'C', 'D', 'E'];

export const SIGNAL_STRENGTH_OPTIONS = ['strong', 'medium', 'weak'];

export const PRIMARY_DATA_CATEGORY_OPTIONS = [
  'project_announcement',
  'permit_filing',
  'company_profile',
  'contact_information',
  'financial_data',
  'regulatory_filing',
  'construction_phase',
  'technology_adoption',
  'funding_event',
  'market_trend',
  'competitor_intelligence',
  'geographic_data',
  'energy_project',
  'public_procurement',
  'property_intelligence',
];

export const API_TYPE_OPTIONS = ['rest', 'graphql', 'rss', 'ftp', 'webhook', 'csv_upload', 'web_scraping'];

export const AUTH_TYPE_OPTIONS = ['api_key', 'oauth2', 'basic_auth', 'none', 'ip_whitelist', 'proxy'];

export const DATA_FORMAT_OPTIONS = ['json', 'xml', 'csv', 'html', 'geojson', 'rss'];

export const DATA_FRESHNESS_OPTIONS = ['real_time', 'daily', 'weekly', 'monthly', 'quarterly'];

export const HEALTH_STATUS_OPTIONS = ['healthy', 'degraded', 'failing', 'disabled', 'unconfigured'];

export const CRITICAL_FIELD_OPTIONS = [
  'project_name',
  'project_value',
  'project_location',
  'project_timeline',
  'building_type',
  'company_name',
  'company_contact',
  'project_phase',
  'square_footage',
  'funding_source',
  'company_website',
  'company_phone',
];

export const SORT_FIELD_OPTIONS: { value: string; label: string }[] = [
  { value: 'priority_rank', label: 'Priority rank' },
  { value: 'overall_priority_score', label: 'Priority score' },
  { value: 'completeness_score', label: 'Completeness score' },
  { value: 'source_name', label: 'Source name' },
];
