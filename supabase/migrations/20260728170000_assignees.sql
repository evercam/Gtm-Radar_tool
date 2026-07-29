-- ============================================================================
-- 20260728170000_assignees
-- ----------------------------------------------------------------------------
-- People who receive leads without needing a login.
--
-- Until now a lead could only be owned by a `user_profiles` row, and that
-- table's primary key references `auth.users` — so owning a lead required an
-- invitation, an email, and someone accepting it. That is the wrong shape for
-- how this actually runs: an admin builds the list and hands it to a BDR, and
-- what the BDR needs is their name on the record and on the sheet, not an
-- account in a tool they never open.
--
-- So the roster is its own table. A person here may optionally be linked to a
-- real user (`user_id`), which is what makes "My Leads" work for the ones who
-- do log in — but the link is nullable and nothing depends on it.
--
-- `canonical_projects.assignee_id` becomes who owns the lead. `owner_user_id`
-- stays, and is kept in step for linked assignees, so every existing query,
-- RLS policy and "my leads" filter keeps working untouched.
-- ============================================================================

create table if not exists public.assignees (
  id uuid primary key default gen_random_uuid(),

  name text not null,
  email text,

  role text not null default 'bdr'
    check (role in ('bdr', 'sdr', 'ae', 'marketing', 'sales_manager', 'admin')),

  -- Hard scope: a lead outside these is never assigned to this person.
  bu text[] not null default '{}',
  verticals text[] not null default '{}',
  regions text[] not null default '{}',

  -- Soft preference: only breaks ties between people who are equally free.
  preferred_verticals text[] not null default '{}',

  daily_lead_quota integer not null default 50,
  is_active boolean not null default true,

  /**
   * The app account for this person, when they have one. Null is the normal
   * case — most of the roster never logs in.
   */
  user_id uuid references public.user_profiles(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_assignees_user on public.assignees (user_id) where user_id is not null;
create index if not exists idx_assignees_active on public.assignees (is_active, role);

drop trigger if exists trg_assignees_updated_at on public.assignees;
create trigger trg_assignees_updated_at
  before update on public.assignees
  for each row execute function public.set_updated_at();

alter table public.canonical_projects
  add column if not exists assignee_id uuid references public.assignees(id) on delete set null;

create index if not exists idx_projects_assignee
  on public.canonical_projects (assignee_id)
  where assignee_id is not null;

comment on column public.canonical_projects.assignee_id is
  'Who owns this lead. owner_user_id mirrors it when the assignee has an app account.';

-- Everyone who can already receive leads becomes a roster entry, so nothing
-- that was assigned before this migration loses its owner.
insert into public.assignees (name, email, role, bu, verticals, regions, daily_lead_quota, is_active, user_id)
select
  coalesce(nullif(trim(p.full_name), ''), p.email, 'Unnamed'),
  p.email,
  p.role,
  p.bu,
  p.verticals,
  p.regions,
  p.daily_lead_quota,
  p.is_active,
  p.id
from public.user_profiles p
where not exists (select 1 from public.assignees a where a.user_id = p.id);

update public.canonical_projects c
set assignee_id = a.id
from public.assignees a
where c.owner_user_id is not null
  and a.user_id = c.owner_user_id
  and c.assignee_id is null;

-- Readable by any signed-in user — the roster is who to hand work to, not a
-- secret. Written only through the service role behind an admin check.
do $$
begin
  if to_regclass('public.assignees') is not null then
    alter table public.assignees enable row level security;
    drop policy if exists assignees_select on public.assignees;
    create policy assignees_select on public.assignees
      for select to authenticated using (true);
  end if;
end $$;
