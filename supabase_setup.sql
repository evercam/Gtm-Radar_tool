-- supabase_setup.sql — generated from supabase/migrations/*. No RLS.

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

-- ============================================================================
-- 20260725133259_provenance
-- ----------------------------------------------------------------------------
-- Field-level data provenance: know whether each value is original (from the
-- source) or was added by enrichment (Claude / Apollo), and exactly which
-- columns enrichment filled.
--
--   field_provenance  jsonb  { "<column>": "source" | "claude" | "apollo", ... }
--   enrichment_jobs   jsonb  (already present) — appended one entry per run:
--                            { at, engines, fields_added:[...], account, confidence }
--
-- Rule enforced by the app: enrichment only fills EMPTY columns, so a value
-- marked "source" is never overwritten — original data stays original.
--
-- Two company columns added so Claude's account resolution has somewhere to
-- land (previously there was no column for them).
-- ============================================================================

alter table public.canonical_projects
  add column if not exists company_website text,
  add column if not exists company_domain text,
  add column if not exists field_provenance jsonb not null default '{}'::jsonb;

create index if not exists idx_projects_provenance_gin
  on public.canonical_projects using gin (field_provenance);

-- ============================================================================
-- 20260725133260_sdr_fields
-- ----------------------------------------------------------------------------
-- SDR-facing intelligence Claude generates per record: should I call, when,
-- and what do I say. Populated by enrichment and tagged 'claude' in
-- field_provenance. All nullable — a record is valid without them.
-- ============================================================================

alter table public.canonical_projects
  add column if not exists icp_fit_score integer,          -- 0..100 fit to Evercam ICP
  add column if not exists icp_fit_reason text,
  add column if not exists evercam_timing text
    check (evercam_timing in ('reach_now', 'watch', 'too_early', 'too_late')),
  add column if not exists trigger_event text,             -- the event making now the moment
  add column if not exists opening_hook text,              -- personalized first line
  add column if not exists value_angle text
    check (value_angle in ('confidence', 'evidence', 'capacity')),
  add column if not exists pain_point text,
  add column if not exists account_key text;               -- Claude's normalized company identity

create index if not exists idx_projects_icp_fit     on public.canonical_projects (icp_fit_score desc);
create index if not exists idx_projects_timing      on public.canonical_projects (evercam_timing);
create index if not exists idx_projects_account_key on public.canonical_projects (account_key);

-- ============================================================================
-- 20260725133261_accounts
-- ----------------------------------------------------------------------------
-- Account layer on top of the one project table. Accounts are keyed by
-- account_key (Claude's normalized company identity, also on canonical_projects).
--
--   account_enrichment  one row per account — what Claude finds about the COMPANY
--                       (related entities, related projects, key-account score).
--   accounts_view       aggregates projects by account_key and joins the
--                       enrichment — the queryable "accounts" surface.
--
-- The single ingestion table (canonical_projects) is unchanged; this is a thin
-- derived/enrichment layer.
-- ============================================================================

create table if not exists public.account_enrichment (
  account_key text primary key,
  account_name text,
  account_role text,                 -- owner / developer / general_contractor / operator / architect
  parent_account text,
  related_entities jsonb default '[]'::jsonb,   -- [{ name, role, relationship }]
  related_projects jsonb default '[]'::jsonb,   -- [{ name, location, stage, est_value }]
  portfolio_project_count integer,
  portfolio_value_estimate numeric(15,2),
  revenue_band text,
  employee_count integer,
  expansion_signal text,
  tech_stack jsonb default '[]'::jsonb,
  -- key-account verdict (score computed by the app rubric; see lib/keyaccount.ts)
  key_account boolean default false,
  key_account_score integer,
  key_account_reasons jsonb default '[]'::jsonb,
  -- provenance / audit, same model as canonical_projects
  field_provenance jsonb not null default '{}'::jsonb,
  enrichment_jobs jsonb default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_accounts_key_account on public.account_enrichment (key_account, key_account_score desc);

drop trigger if exists trg_account_enrichment_updated_at on public.account_enrichment;
create trigger trg_account_enrichment_updated_at
  before update on public.account_enrichment
  for each row execute function public.set_updated_at();

-- Aggregated accounts surface: portfolio rollup per account_key + enrichment.
-- drop-then-create (not "create or replace") so column order can change safely.
drop view if exists public.accounts_view;
create view public.accounts_view as
select
  p.account_key,
  coalesce(e.account_name, max(p.company_name_raw))          as account_name,
  e.account_role,
  count(*)                                                    as project_count,
  -- portfolio size: the owner's asset count from enrichment (GEOT etc.), else
  -- the number of ingested project rows for this account.
  coalesce(e.portfolio_project_count, count(*)::int)          as portfolio_project_count,
  count(*) filter (where p.contact_status = 'has_contact')    as with_contact,
  coalesce(sum(p.estimated_value), e.portfolio_value_estimate) as total_value,
  max(p.estimated_value)                                      as largest_project_value,
  max(p.capacity_mw)                                          as capacity_mw,
  array_agg(distinct p.bu)                                    as bus,
  array_agg(distinct p.vertical)                              as verticals,
  min(p.announced_date)                                       as earliest_announced,
  max(p.announced_date)                                       as latest_announced,
  coalesce(e.key_account, false)                              as key_account,
  e.key_account_score,
  e.key_account_reasons,
  e.related_projects,
  e.related_entities,
  e.expansion_signal
from public.canonical_projects p
left join public.account_enrichment e on e.account_key = p.account_key
where p.account_key is not null
group by p.account_key, e.account_name, e.account_role, e.key_account,
         e.key_account_score, e.key_account_reasons, e.related_projects,
         e.related_entities, e.expansion_signal, e.portfolio_project_count,
         e.portfolio_value_estimate;

-- ============================================================================
-- 20260726090000_routing_policy
-- ----------------------------------------------------------------------------
-- Admin-defined routing/disposition rules (single row). The app falls back to
-- built-in defaults when this is empty, so it works before this is populated.
-- ============================================================================

create table if not exists public.routing_policy (
  id text primary key default 'default',
  rules jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_routing_policy_updated_at on public.routing_policy;
create trigger trg_routing_policy_updated_at
  before update on public.routing_policy
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 20260726100000_routing_columns
-- ----------------------------------------------------------------------------
-- Materialized disposition on each record — written by the routing engine
-- ("Re-route all" / on ingest). Lets you filter and count records by lane.
-- ============================================================================

alter table public.canonical_projects
  add column if not exists route text,            -- sales | marketing | partner | none
  add column if not exists stage text,            -- act_now | qualify | nurture | hold | disqualify
  add column if not exists assigned_team text,
  add column if not exists routing_reason text,   -- which rule fired
  add column if not exists routed_at timestamptz;

create index if not exists idx_projects_route on public.canonical_projects (route, stage);


-- ============================================================================
-- 20260726110000_priority_and_enrichment_runs
-- ----------------------------------------------------------------------------
-- Makes the lanes workable, and moves the last hardcoded rules into the DB:
--
--   1. scoring_policy / enrichment_policy — admin-editable parameters, same
--      single-row pattern as routing_policy. The app falls back to built-in
--      defaults when a row is missing, so it works before either is populated.
--   2. Materialized lead priority on each record — written by the scoring pass
--      ("Re-score all" / on ingest). Routing rules match on it and the
--      enrichment queue is ordered by it, so spend goes to the best records.
--   3. enrichment_runs — one row per batch job, so the control centre can show
--      what ran, over what, and with what result.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Admin-parameterized policies
-- ----------------------------------------------------------------------------
create table if not exists public.scoring_policy (
  id text primary key default 'default',
  config jsonb not null default '{}'::jsonb,   -- shape: lib/priority.ts PriorityConfig
  updated_at timestamptz not null default now()
);

create table if not exists public.enrichment_policy (
  id text primary key default 'default',
  config jsonb not null default '{}'::jsonb,   -- shape: lib/enrich/policy.ts EnrichmentPolicy
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_scoring_policy_updated_at on public.scoring_policy;
create trigger trg_scoring_policy_updated_at
  before update on public.scoring_policy
  for each row execute function public.set_updated_at();

drop trigger if exists trg_enrichment_policy_updated_at on public.enrichment_policy;
create trigger trg_enrichment_policy_updated_at
  before update on public.enrichment_policy
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Materialized priority on each record
-- ----------------------------------------------------------------------------
alter table public.canonical_projects
  add column if not exists priority_score integer,    -- 0..100 (lib/priority.ts)
  add column if not exists priority_band text,        -- P1 | P2 | P3 | P4
  add column if not exists priority_reasons jsonb default '[]'::jsonb,
  add column if not exists scored_at timestamptz,
  -- when enrichment last ran for this record, so a batch can skip fresh ones
  add column if not exists enriched_at timestamptz;

-- "Top leads" and the queue both read priority desc.
create index if not exists idx_projects_priority
  on public.canonical_projects (priority_score desc nulls last);

-- Queue query: "needs enrichment, highest priority first".
create index if not exists idx_projects_enrich_queue
  on public.canonical_projects (contact_status, priority_score desc nulls last);

-- ----------------------------------------------------------------------------
-- Batch enrichment history
-- ----------------------------------------------------------------------------
create table if not exists public.enrichment_runs (
  id uuid primary key default gen_random_uuid(),

  -- what was targeted
  filters jsonb not null default '{}'::jsonb,  -- the queue filter this run used
  requested integer not null default 0,        -- how many records were selected
  succeeded integer not null default 0,
  failed integer not null default 0,
  skipped integer not null default 0,

  -- what happened
  engines jsonb not null default '{}'::jsonb,  -- { claude: true, apollo: false }
  fields_added integer not null default 0,     -- columns filled across the run
  contacts_found integer not null default 0,
  results jsonb not null default '[]'::jsonb,  -- per-record outcome, for the detail view
  error text,

  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer
);

create index if not exists idx_enrichment_runs_started
  on public.enrichment_runs (started_at desc);
