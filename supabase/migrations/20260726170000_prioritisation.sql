-- ============================================================================
-- 20260726170000_prioritisation
-- ----------------------------------------------------------------------------
-- The selection layer that decides which records are worth enriching.
--
--   enrichment_rules      admin-editable rule list (conditions/volume/action),
--                         same single-row policy pattern as routing_policy
--   prioritisation_runs   one row per daily selection pass, so the planner can
--                         show what was queued and what was deferred
--   snooze columns        per-record deferral, so an operator can push a lead
--                         to tomorrow or next week without disqualifying it
-- ============================================================================

create table if not exists public.enrichment_rules (
  id text primary key default 'default',
  rules jsonb not null default '[]'::jsonb,   -- shape: lib/enrich/rules.ts EnrichmentRule[]
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_enrichment_rules_updated_at on public.enrichment_rules;
create trigger trg_enrichment_rules_updated_at
  before update on public.enrichment_rules
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Daily selection history
-- ----------------------------------------------------------------------------
create table if not exists public.prioritisation_runs (
  id uuid primary key default gen_random_uuid(),

  trigger text not null default 'manual' check (trigger in ('manual', 'cron')),
  triggered_by uuid,

  candidates integer not null default 0,   -- records considered
  selected integer not null default 0,     -- moved to PENDING_ENRICHMENT
  deferred integer not null default 0,     -- matched a rule but over a limit
  unmatched integer not null default 0,    -- matched no rule at all
  global_cap integer,

  -- per-rule breakdown: [{ ruleId, ruleName, count, overflow }]
  by_rule jsonb not null default '[]'::jsonb,

  status text not null default 'completed' check (status in ('running', 'completed', 'failed')),
  error text,

  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer
);

create index if not exists idx_prioritisation_runs_started
  on public.prioritisation_runs (started_at desc);

-- ----------------------------------------------------------------------------
-- Per-record deferral
-- ----------------------------------------------------------------------------
-- Snoozing is not the same as disqualifying: the record stays eligible, it is
-- simply skipped until the date passes. Without this an operator's only way to
-- get a record out of today's queue would be to mark it LOST.
alter table public.canonical_projects
  add column if not exists snoozed_until date,
  add column if not exists snooze_reason text,
  -- set when an operator forces a record into the queue outside the rules
  add column if not exists force_enrich boolean not null default false,
  -- which rule claimed it, for the audit trail
  add column if not exists selected_by_rule text;

create index if not exists idx_projects_snoozed
  on public.canonical_projects (snoozed_until)
  where snoozed_until is not null;

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.enrichment_rules enable row level security;
alter table public.prioritisation_runs enable row level security;

drop policy if exists enrichment_rules_select on public.enrichment_rules;
create policy enrichment_rules_select on public.enrichment_rules
  for select to authenticated using (true);

drop policy if exists prioritisation_runs_select on public.prioritisation_runs;
create policy prioritisation_runs_select on public.prioritisation_runs
  for select to authenticated using (true);
