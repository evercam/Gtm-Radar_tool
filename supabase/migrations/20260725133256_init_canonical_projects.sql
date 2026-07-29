-- ============================================================================
-- 20260725133256_init_canonical_projects
-- ----------------------------------------------------------------------------
-- One universal ingestion table for every source. Adapters normalize each
-- source's own structure into the shared, queryable columns below; the full
-- original record is preserved verbatim in `raw_data` (JSONB), so the table
-- ingests ANY source shape without a schema change.
--
--   • typed columns  -> normalized cross-source common view (query these)
--   • raw_data JSONB -> source's original structure, exactly as received
--   • (source_key, source_unique_id) -> which source + its native id (unique)
--
-- No lookup tables and no seed: icp_code / bu / record_type / completeness tier
-- are plain values set by each adapter. gen_random_uuid() is built into Postgres
-- 13+ (and Supabase), so no extension is required.
-- ============================================================================

create table if not exists public.canonical_projects (
  id uuid primary key default gen_random_uuid(),

  -- identity ----------------------------------------------------------------
  canonical_name text not null,
  source_key text not null,          -- which source produced the record
  source_unique_id text not null,    -- the source's own id for it
  icp_code text,                     -- ideal-customer profile (plain value)
  record_type text not null default 'project' check (record_type in (
    'project', 'tender', 'permit', 'filing', 'news', 'account', 'contact', 'signal'
  )),
  bu text not null default 'export' check (bu in ('usa', 'uk', 'ireland', 'apac', 'export')),

  -- project -----------------------------------------------------------------
  project_type text,
  building_type text,
  description text,
  square_footage numeric(12,2),
  number_of_floors integer,
  capacity_mw numeric(12,2),         -- energy/GEM capacity
  technology_type text,

  -- location ----------------------------------------------------------------
  address_line1 text,
  city text,
  state_province text,
  country text,
  country_code char(2),
  latitude numeric(10,7),
  longitude numeric(10,7),
  is_remote_location boolean default false,
  is_access_constrained boolean default false,

  -- timeline ----------------------------------------------------------------
  announced_date date,
  construction_start_date date,
  estimated_completion_date date,
  bid_date date,

  -- commercial --------------------------------------------------------------
  project_url text,
  current_phase text,
  estimated_value numeric(15,2),
  estimated_value_currency char(3) default 'USD',

  -- company & contact -------------------------------------------------------
  company_name_raw text,
  company_id uuid,
  contact_name text,
  contact_title text,
  contact_email text,
  contact_phone text,

  -- data quality (computed per record by the adapter) -----------------------
  source_completeness_tier text,     -- 'A'..'E'
  source_completeness_score integer,
  fields_populated jsonb default '{}'::jsonb,
  fields_missing jsonb default '[]'::jsonb,
  population_percentage numeric(5,2),
  enriched_completeness_tier text,
  enriched_completeness_score integer,
  enrichment_gap_closed_percentage numeric(5,2),

  -- scoring -----------------------------------------------------------------
  confidence_score numeric(5,2),
  evidence_score numeric(5,2),
  capacity_score numeric(5,2),
  composite_score numeric(5,2),

  -- lifecycle ---------------------------------------------------------------
  processing_status text default 'ingested' check (processing_status in (
    'ingested', 'normalized', 'enriching', 'enriched', 'scored',
    'qualified', 'routed', 'failed', 'duplicate'
  )),

  -- the source's original record, verbatim — digests ANY structure ----------
  raw_data jsonb,
  enrichment_jobs jsonb default '[]'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- one row per (source, native id); re-ingesting upserts in place ----------
  constraint canonical_projects_source_uid_key unique (source_key, source_unique_id)
);

-- indexes for the common access patterns -------------------------------------
create index if not exists idx_projects_source       on public.canonical_projects (source_key);
create index if not exists idx_projects_icp          on public.canonical_projects (icp_code);
create index if not exists idx_projects_bu           on public.canonical_projects (bu);
create index if not exists idx_projects_record_type  on public.canonical_projects (record_type);
create index if not exists idx_projects_status       on public.canonical_projects (processing_status);
create index if not exists idx_projects_country      on public.canonical_projects (country_code);
create index if not exists idx_projects_created      on public.canonical_projects (created_at desc);
create index if not exists idx_projects_composite    on public.canonical_projects (composite_score desc);
create index if not exists idx_projects_completeness on public.canonical_projects (population_percentage desc);
-- query inside the untyped payload, e.g. raw_data->>'Operator'
create index if not exists idx_projects_raw_gin      on public.canonical_projects using gin (raw_data);

-- keep updated_at fresh on every UPDATE --------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_canonical_projects_updated_at on public.canonical_projects;
create trigger trg_canonical_projects_updated_at
  before update on public.canonical_projects
  for each row execute function public.set_updated_at();
