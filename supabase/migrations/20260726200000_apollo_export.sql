-- ============================================================================
-- 20260726200000_apollo_export
-- ----------------------------------------------------------------------------
-- Pushing finished leads into Apollo, and the record of having done so.
--
--   export_runs        one row per daily batch
--   per-lead columns   what Apollo did with each contact, so a lead is never
--                      pushed twice and a failure is visible on the record
--
-- Apollo's bulk_create is not idempotent from our side: sending the same
-- contact twice creates noise in the destination list. `apollo_exported_at`
-- is what stops that, so it is set on success only.
-- ============================================================================

create table if not exists public.export_runs (
  id uuid primary key default gen_random_uuid(),

  destination text not null default 'apollo',
  trigger text not null default 'manual' check (trigger in ('manual', 'cron')),
  triggered_by uuid,
  filters jsonb not null default '{}'::jsonb,

  requested integer not null default 0,
  created integer not null default 0,     -- new contacts in Apollo
  existing integer not null default 0,    -- already there (not an error)
  failed integer not null default 0,
  batches integer not null default 0,     -- Apollo caps bulk_create at 100

  error text,
  results jsonb not null default '[]'::jsonb,

  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer
);

create index if not exists idx_export_runs_started on public.export_runs (started_at desc);

-- ----------------------------------------------------------------------------
-- Per-lead export state
-- ----------------------------------------------------------------------------
alter table public.canonical_projects
  add column if not exists apollo_exported_at timestamptz,
  add column if not exists apollo_contact_id text,
  add column if not exists apollo_export_status text
    check (apollo_export_status is null or apollo_export_status in ('created', 'existing', 'failed')),
  add column if not exists apollo_export_error text;

-- The export query: eligible, not yet sent, best first.
create index if not exists idx_projects_apollo_pending
  on public.canonical_projects (apollo_exported_at, priority_score desc nulls last)
  where apollo_exported_at is null;

alter table public.export_runs enable row level security;

drop policy if exists export_runs_select on public.export_runs;
create policy export_runs_select on public.export_runs
  for select to authenticated using (true);
