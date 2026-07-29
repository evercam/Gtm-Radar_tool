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
