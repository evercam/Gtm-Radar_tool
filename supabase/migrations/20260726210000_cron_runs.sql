-- ============================================================================
-- 20260726210000_cron_runs
-- ----------------------------------------------------------------------------
-- A record of every scheduled run.
--
-- Without this a scheduler that silently stops firing looks identical to a
-- quiet day — there is nothing to distinguish "nothing was due" from "nothing
-- ran". The Control Center reads the newest row to show when the scheduler was
-- last heard from.
-- ============================================================================

create table if not exists public.cron_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  ok boolean not null default false,
  results jsonb not null default '[]'::jsonb,
  duration_ms integer,
  ran_at timestamptz not null default now()
);

create index if not exists idx_cron_runs_ran_at on public.cron_runs (ran_at desc);

alter table public.cron_runs enable row level security;

drop policy if exists cron_runs_select on public.cron_runs;
create policy cron_runs_select on public.cron_runs
  for select to authenticated using (true);
