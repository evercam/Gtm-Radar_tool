-- ============================================================================
-- 20260725133258_classification_and_ids
-- ----------------------------------------------------------------------------
-- Best-practice organisation for canonical_projects. Adds derived, always-
-- correct classification computed by Postgres (STORED generated columns), so
-- there is zero app logic to keep in sync.
--
-- IDENTITY (stable) vs ORGANISATION (reflects current state):
--   ref_code  BU-VERTICAL-COUNTRY-HASH   stable business id, e.g. USA-DCTR-US-A1B2C3D4
--   org_path  bu/vertical/country/state/contact_status  groupable path, e.g.
--             usa/data_center/US/California/needs_enrichment
--
-- Rules per segment:
--   BU        geography-derived business unit (usa/uk/ireland/apac/export)
--   VERTICAL  sector inferred from building/project type, else record_type
--   COUNTRY   ISO-2 country_code
--   HASH      left(md5(source_key|source_unique_id),8) — stable & idempotent
--   contact_status  has_contact if any contact_* present, else needs_enrichment
--
-- Mutable state (contact_status, phase) is deliberately kept OUT of ref_code so
-- identity never changes when enrichment fills a contact; it lives in columns
-- and in org_path for grouping/rollups instead.
-- ============================================================================

-- ---- helper functions (IMMUTABLE so generated columns may use them) --------

create or replace function public.lead_vertical(bt text, pt text, rt text)
returns text immutable language sql as $$
  select case
    when lower(coalesce(bt, pt, '')) like '%data cent%'                                             then 'data_center'
    when lower(coalesce(bt, pt, '')) like '%semiconduct%' or lower(coalesce(bt, pt, '')) like '%fab%' then 'semiconductor'
    when lower(coalesce(bt, pt, '')) like '%batter%'     or lower(coalesce(bt, pt, '')) like '%gigafact%' then 'battery'
    when lower(coalesce(bt, pt, '')) like '%solar%'                                                 then 'solar'
    when lower(coalesce(bt, pt, '')) like '%wind%'                                                  then 'wind'
    when lower(coalesce(bt, pt, '')) like '%nuclear%'                                               then 'nuclear'
    when lower(coalesce(bt, pt, '')) like '%hydro%'                                                 then 'hydro'
    when lower(coalesce(bt, pt, '')) like '%pipeline%'                                              then 'pipeline'
    when lower(coalesce(bt, pt, '')) like '%coal%'                                                  then 'coal'
    when lower(coalesce(bt, pt, '')) like '%oil%' or lower(coalesce(bt, pt, '')) like '%gas%'
      or lower(coalesce(bt, pt, '')) like '%lng%'                                                   then 'oil_gas'
    when lower(coalesce(bt, pt, '')) like '%mine%' or lower(coalesce(bt, pt, '')) like '%mining%'   then 'mining'
    when lower(coalesce(bt, pt, '')) like '%steel%'                                                 then 'steel'
    when lower(coalesce(bt, pt, '')) like '%cement%'                                                then 'cement'
    when lower(coalesce(bt, pt, '')) like '%chemical%'                                              then 'chemicals'
    when rt = 'tender' then 'procurement'
    when rt = 'permit' then 'construction'
    when rt = 'news'   then 'market_intel'
    when rt = 'filing' then 'capital_markets'
    else 'other'
  end
$$;

create or replace function public.lead_vertical_code(v text)
returns text immutable language sql as $$
  select case v
    when 'data_center'     then 'DCTR' when 'semiconductor' then 'SEMI' when 'battery'      then 'BATT'
    when 'solar'           then 'SOLR' when 'wind'          then 'WIND' when 'nuclear'      then 'NUCL'
    when 'hydro'           then 'HYDR' when 'pipeline'      then 'PIPE' when 'coal'         then 'COAL'
    when 'oil_gas'         then 'OLGS' when 'mining'        then 'MINE' when 'steel'        then 'STEL'
    when 'cement'          then 'CMNT' when 'chemicals'     then 'CHEM' when 'procurement'  then 'PROC'
    when 'construction'    then 'CNST' when 'market_intel'  then 'MINT' when 'capital_markets' then 'CAPM'
    else 'OTHR'
  end
$$;

create or replace function public.lead_bu_code(b text)
returns text immutable language sql as $$
  select case b
    when 'usa' then 'USA' when 'uk' then 'UK' when 'ireland' then 'IE'
    when 'apac' then 'APAC' when 'export' then 'EXP' else upper(coalesce(b, 'XX'))
  end
$$;

-- ---- derived classification columns ----------------------------------------

alter table public.canonical_projects
  add column if not exists vertical text
    generated always as (public.lead_vertical(building_type, project_type, record_type)) stored,

  add column if not exists contact_status text
    generated always as (
      case
        when contact_email is not null or contact_phone is not null or contact_name is not null
        then 'has_contact' else 'needs_enrichment'
      end
    ) stored,

  -- stable, human-readable business id: BU-VERTICAL-COUNTRY-HASH
  add column if not exists ref_code text
    generated always as (
      public.lead_bu_code(bu) || '-' ||
      public.lead_vertical_code(public.lead_vertical(building_type, project_type, record_type)) || '-' ||
      coalesce(upper(country_code), 'XX') || '-' ||
      upper(left(md5(source_key || '|' || source_unique_id), 8))
    ) stored,

  -- organising path incl. mutable dims (contact status, geo) for grouping
  add column if not exists org_path text
    generated always as (
      bu || '/' ||
      public.lead_vertical(building_type, project_type, record_type) || '/' ||
      coalesce(upper(country_code), 'XX') || '/' ||
      coalesce(nullif(state_province, ''), 'unknown') || '/' ||
      (case
        when contact_email is not null or contact_phone is not null or contact_name is not null
        then 'has_contact' else 'needs_enrichment'
      end)
    ) stored;

-- ---- indexes for the organising dimensions ---------------------------------
create index if not exists idx_projects_vertical       on public.canonical_projects (vertical);
create index if not exists idx_projects_contact_status on public.canonical_projects (contact_status);
create index if not exists idx_projects_ref_code       on public.canonical_projects (ref_code);
create index if not exists idx_projects_state          on public.canonical_projects (state_province);
create index if not exists idx_projects_city           on public.canonical_projects (city);
-- the common rollup: BU -> vertical -> contact status
create index if not exists idx_projects_org            on public.canonical_projects (bu, vertical, contact_status);
