-- ============================================================================
-- 20260729100000_google_oauth
-- ----------------------------------------------------------------------------
-- Who is allowed in once sign-in is open to Google.
--
-- Password and magic-link sign-in are effectively invite-only: somebody has to
-- create the account. A Google provider is not — the button is public, and
-- anyone with any Google account can press it. The existing trigger would then
-- hand them a live 'bdr' profile, and 'bdr' can read leads.
--
-- So new accounts are admitted by email domain. An address on the allow-list
-- lands active as usual; anything else still gets a profile — the auth user
-- exists either way, and a row is what lets an admin see the request and
-- approve it — but lands INACTIVE, which every layer already refuses:
-- requireUser, checkPermission, the proxy, and the RLS policies below.
--
-- An empty allow-list means "admit nobody automatically". That is the safe
-- default for an install that has not thought about it yet, and it never locks
-- the owner out: the first-admin bootstrap still fires first and is exempt.
--
-- The Google client id and secret are NOT stored here. They belong to the
-- Supabase project's auth configuration, which keeps this install's rule of
-- no application secrets outside the database intact.
-- ============================================================================

create table if not exists public.auth_settings (
  id text primary key default 'default',
  -- Bare domains, lower-case, no '@': {evercam.com}
  allowed_domains text[] not null default '{}'::text[],
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_auth_settings_updated_at on public.auth_settings;
create trigger trg_auth_settings_updated_at
  before update on public.auth_settings
  for each row execute function public.set_updated_at();

insert into public.auth_settings (id) values ('default') on conflict (id) do nothing;

comment on table public.auth_settings is
  'Which email domains may sign in by themselves. Empty means every new account needs an admin to activate it.';

-- Seed the allow-list from the domain the install already trusts: whoever is
-- admin today. Without this, enabling Google on a working install would put
-- the owner''s own colleagues into the pending queue on their first sign-in.
-- Only runs while the list is untouched.
do $$
declare
  seeded text[];
begin
  if exists (select 1 from public.auth_settings where id = 'default' and allowed_domains = '{}'::text[]) then
    select array_agg(distinct lower(split_part(email, '@', 2)))
      into seeded
    from public.user_profiles
    where role = 'admin' and is_active = true and email like '%@%';

    if seeded is not null then
      update public.auth_settings set allowed_domains = seeded where id = 'default';
    end if;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- The trigger, now domain-aware.
--
-- Supersedes 20260726180000_bootstrap_first_admin. That migration's one-shot
-- elevation is reproduced verbatim and still runs first, so the very first
-- account is admin AND active no matter what the allow-list says.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_count integer;
  assigned_role text := 'bdr';
  allowed text[];
  domain text;
  admitted boolean;
begin
  select count(*) into admin_count
  from public.user_profiles
  where role = 'admin' and is_active = true;

  if admin_count = 0 then
    -- First account in: admin, active, exempt from the allow-list. Anything
    -- else would leave a fresh install with nobody able to administer it.
    assigned_role := 'admin';
    admitted := true;
  else
    select allowed_domains into allowed from public.auth_settings where id = 'default';
    domain := lower(split_part(coalesce(new.email, ''), '@', 2));
    admitted := domain <> '' and allowed is not null and domain = any(allowed);
  end if;

  insert into public.user_profiles (id, email, full_name, role, is_active)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    assigned_role,
    admitted
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- An inactive profile must be able to read ITSELF and nothing else, so the
-- pending screen can say "waiting for approval" rather than bouncing the
-- visitor to a sign-in page they have already used successfully.
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.user_profiles') is not null then
    drop policy if exists user_profiles_select_self on public.user_profiles;
    create policy user_profiles_select_self on public.user_profiles
      for select to authenticated using (id = auth.uid());
  end if;

  if to_regclass('public.auth_settings') is not null then
    alter table public.auth_settings enable row level security;
    -- Admin-only: the allow-list is an access-control decision, and it is
    -- written through the service role behind the same check in the route.
    drop policy if exists auth_settings_select on public.auth_settings;
    create policy auth_settings_select on public.auth_settings
      for select to authenticated using (public.is_admin());
  end if;
end $$;
