-- ============================================================================
-- 20260726160000_source_config_and_runs
-- ----------------------------------------------------------------------------
-- Per-source ingestion control and observability.
--
--   source_config    what each adapter is allowed to do — enabled, schedule,
--                    monthly request cap, page size, dedupe strategy
--   ingestion_runs   one row per run, so /control/seeding can show history,
--                    live progress and error logs
--   health columns   rolling uptime, latency and error rate per source
--
-- Both tables are keyed on the adapter slug (`glenigan`, `sam-gov`) rather
-- than the source_key, because that is what the routes and the catalog use.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Per-source configuration
-- ----------------------------------------------------------------------------
create table if not exists public.source_config (
  slug text primary key,

  is_enabled boolean not null default true,

  -- 'cron' runs on the schedule below; 'manual' only ever runs when triggered.
  ingest_mode text not null default 'cron' check (ingest_mode in ('cron', 'manual', 'realtime')),
  -- Standard 5-field cron. Null means "use the global default schedule".
  schedule_cron text,
  timezone text not null default 'UTC',

  -- Spend and volume rails
  monthly_request_cap integer,          -- null = uncapped
  requests_this_month integer not null default 0,
  month_reset_at date,                  -- when requests_this_month last rolled over
  page_size integer not null default 50,
  max_records_per_run integer not null default 500,

  -- Connection tuning
  timeout_ms integer not null default 30000,
  rate_limit_per_minute integer,

  -- How duplicates are detected on top of the (source_key, source_unique_id)
  -- unique constraint that already exists.
  dedupe_strategy text not null default 'source_id'
    check (dedupe_strategy in ('source_id', 'name_location', 'domain', 'email')),

  -- Rolling health, updated by every run
  health_status text not null default 'unconfigured'
    check (health_status in ('healthy', 'degraded', 'failing', 'disabled', 'unconfigured')),
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0,
  avg_latency_ms integer,
  total_runs integer not null default 0,
  total_failures integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_source_config_updated_at on public.source_config;
create trigger trg_source_config_updated_at
  before update on public.source_config
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Ingestion run history
-- ----------------------------------------------------------------------------
create table if not exists public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  source_key text,

  -- how it was started
  trigger text not null default 'manual' check (trigger in ('manual', 'cron', 'backfill')),
  triggered_by uuid,
  params jsonb not null default '{}'::jsonb,

  -- outcome
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  fetched integer not null default 0,      -- rows the adapter returned
  normalized integer not null default 0,   -- rows that survived normalization
  inserted integer not null default 0,
  updated integer not null default 0,
  duplicates integer not null default 0,
  failed integer not null default 0,
  error text,
  error_kind text,                         -- auth | network | shape | unknown

  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer
);

create index if not exists idx_ingestion_runs_slug on public.ingestion_runs (slug, started_at desc);
create index if not exists idx_ingestion_runs_started on public.ingestion_runs (started_at desc);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
-- Config carries no secrets (keys live in source_credentials), so any signed-in
-- user may read it to see what is running. Writes go through the service role
-- behind an admin check in the route.
alter table public.source_config enable row level security;
alter table public.ingestion_runs enable row level security;

drop policy if exists source_config_select on public.source_config;
create policy source_config_select on public.source_config
  for select to authenticated using (true);

drop policy if exists ingestion_runs_select on public.ingestion_runs;
create policy ingestion_runs_select on public.ingestion_runs
  for select to authenticated using (true);
