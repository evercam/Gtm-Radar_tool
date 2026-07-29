-- ============================================================================
-- 20260728140000_allocation_policy
-- ----------------------------------------------------------------------------
-- Controls the MIX of leads handed out, not just the volume.
--
-- Quotas already answer "how many does each person get". Assigning strictly by
-- priority score answers "which" in a way that sounds fair and is not:
-- whichever vertical scores highest takes the whole day, so a book that is 34%
-- bioenergy can deliver a week of nothing but bioenergy while sellers lose the
-- accounts they were building.
--
-- Single row, same shape as routing_policy and scoring_policy, so the app
-- falls back to built-in defaults when it is empty.
--
-- Also adds a per-person soft preference. `verticals` on user_profiles is a
-- HARD scope — a lead outside it is never assigned to that person. This new
-- column only breaks ties between people who are equally free, so an account
-- tends to stay with whoever is already building it without ever making a lead
-- unassignable.
-- ============================================================================

create table if not exists public.allocation_policy (
  id text primary key default 'default',
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_allocation_policy_updated_at on public.allocation_policy;
create trigger trg_allocation_policy_updated_at
  before update on public.allocation_policy
  for each row execute function public.set_updated_at();

alter table public.user_profiles
  add column if not exists preferred_verticals text[] not null default '{}'::text[];

comment on column public.user_profiles.preferred_verticals is
  'Soft preference used to break ties during assignment. `verticals` remains the hard scope.';

-- Readable by any signed-in user so the UI can show the mix in force; written
-- only through the service role behind an admin check in the route — the same
-- rule the other policy tables follow.
do $$
begin
  if to_regclass('public.allocation_policy') is not null then
    alter table public.allocation_policy enable row level security;
    drop policy if exists allocation_policy_select on public.allocation_policy;
    create policy allocation_policy_select on public.allocation_policy
      for select to authenticated using (true);
  end if;
end $$;
