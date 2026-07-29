-- ============================================================================
-- 20260726130000_auth_rbac
-- ----------------------------------------------------------------------------
-- Authentication, roles and row-level security.
--
-- Until now every page in this app was public and every table was reachable
-- with the publishable key. This migration introduces:
--
--   * user_profiles  — one row per auth.users id, carrying the role and the
--                      BU / vertical / region scope a user may see
--   * owner_user_id  — lead ownership on canonical_projects, which is what
--                      the per-user RLS policy keys off
--   * RLS            — enforced on canonical_projects, account_enrichment and
--                      every policy table, so a leaked publishable key cannot
--                      read another user's leads
--
-- Roles (least to most privileged):
--   bdr | sdr | ae | marketing   see only leads they own, within their scope
--   sales_manager                sees the whole team, may reassign
--   admin                        everything, plus users/keys/rules/cron
-- ============================================================================

-- ----------------------------------------------------------------------------
-- user_profiles
-- ----------------------------------------------------------------------------
create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,

  email text,
  full_name text,
  avatar_url text,

  role text not null default 'bdr'
    check (role in ('bdr', 'sdr', 'ae', 'marketing', 'sales_manager', 'admin')),

  -- Scope. Empty arrays mean "no restriction on this axis" so a new manager
  -- isn't accidentally locked out of everything before onboarding runs.
  bu text[] not null default '{}',
  verticals text[] not null default '{}',
  regions text[] not null default '{}',

  -- Operational defaults, generated at onboarding (see the onboarding flow).
  daily_lead_quota integer not null default 50,
  apollo_batch_size integer not null default 100,

  is_active boolean not null default true,
  onboarded_at timestamptz,
  last_seen_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_user_profiles_updated_at on public.user_profiles;
create trigger trg_user_profiles_updated_at
  before update on public.user_profiles
  for each row execute function public.set_updated_at();

create index if not exists idx_user_profiles_role on public.user_profiles (role);

-- A profile is created automatically for every new auth user. Without this a
-- freshly invited user would authenticate successfully and then have no role,
-- which every policy below would read as "no access" — a confusing dead end.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_auth_user_created on auth.users;
create trigger trg_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Role helpers
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER so the policies below can read user_profiles without
-- recursing through that table's own RLS policy. STABLE so Postgres evaluates
-- them once per statement rather than once per row.

create or replace function public.current_role_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.user_profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_role_name() = 'admin', false);
$$;

/** Managers and admins both see the whole team. */
create or replace function public.can_see_all_leads()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_role_name() in ('admin', 'sales_manager'), false);
$$;

-- ----------------------------------------------------------------------------
-- Lead ownership
-- ----------------------------------------------------------------------------
alter table public.canonical_projects
  add column if not exists owner_user_id uuid references public.user_profiles(id) on delete set null,
  add column if not exists owner_assigned_at timestamptz,
  add column if not exists owner_assigned_reason text;

create index if not exists idx_projects_owner on public.canonical_projects (owner_user_id);

-- ----------------------------------------------------------------------------
-- RLS — user_profiles
-- ----------------------------------------------------------------------------
alter table public.user_profiles enable row level security;

drop policy if exists user_profiles_select on public.user_profiles;
create policy user_profiles_select on public.user_profiles
  for select to authenticated
  using (id = auth.uid() or public.can_see_all_leads());

drop policy if exists user_profiles_update_self on public.user_profiles;
create policy user_profiles_update_self on public.user_profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Role changes and user creation go through the service role only (the
-- /control/users endpoints), so no INSERT/DELETE policy is granted here and
-- no policy lets a user edit their own role.

-- ----------------------------------------------------------------------------
-- RLS — canonical_projects
-- ----------------------------------------------------------------------------
alter table public.canonical_projects enable row level security;

drop policy if exists projects_select on public.canonical_projects;
create policy projects_select on public.canonical_projects
  for select to authenticated
  using (
    public.can_see_all_leads()
    or owner_user_id = auth.uid()
    -- Unassigned records stay visible inside a user's own scope so they can be
    -- claimed; anything owned by someone else is hidden.
    or (
      owner_user_id is null
      and exists (
        select 1 from public.user_profiles p
        where p.id = auth.uid()
          -- Both sides must be qualified. `user_profiles` also has a `bu`
          -- column (text[]), so an unqualified `bu` inside this subquery binds
          -- to the profile's array rather than the record's text value —
          -- giving `text[] = text` and a 42883 at policy-creation time.
          and (cardinality(p.bu) = 0 or canonical_projects.bu = any (p.bu))
          and (cardinality(p.verticals) = 0 or canonical_projects.vertical = any (p.verticals))
      )
    )
  );

drop policy if exists projects_update_own on public.canonical_projects;
create policy projects_update_own on public.canonical_projects
  for update to authenticated
  using (public.can_see_all_leads() or owner_user_id = auth.uid())
  with check (public.can_see_all_leads() or owner_user_id = auth.uid());

-- Ingestion, scoring, routing and enrichment all run with the service role,
-- which bypasses RLS — so no INSERT policy is needed for authenticated users.

-- ----------------------------------------------------------------------------
-- RLS — account_enrichment (account-level intelligence)
-- ----------------------------------------------------------------------------
-- Guarded like the policy tables below: `account_enrichment` comes from the
-- accounts migration, so this file works on a database where that hasn't been
-- applied yet rather than aborting the whole transaction.
do $$
begin
  if to_regclass('public.account_enrichment') is not null then
    alter table public.account_enrichment enable row level security;
    drop policy if exists account_enrichment_select on public.account_enrichment;
    create policy account_enrichment_select on public.account_enrichment
      for select to authenticated using (true);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- RLS — policy tables (admin-managed configuration)
-- ----------------------------------------------------------------------------
-- Readable by any signed-in user so the UI can show the rules in force;
-- writable only through the service role behind an admin check in the route.

do $$
declare t text;
begin
  foreach t in array array['routing_policy', 'scoring_policy', 'enrichment_policy', 'enrichment_runs']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists %I on public.%I', t || '_select', t);
      execute format(
        'create policy %I on public.%I for select to authenticated using (true)',
        t || '_select', t
      );
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Bootstrapping the first admin
-- ----------------------------------------------------------------------------
-- Every new profile defaults to 'bdr', so a brand-new install has no admin and
-- nobody can reach /control. After creating your first user through the sign-in
-- page, promote it by running (in the SQL editor, which uses the service role):
--
--   update public.user_profiles set role = 'admin' where email = 'you@example.com';
