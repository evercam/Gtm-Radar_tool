-- ============================================================================
-- 20260726180000_bootstrap_first_admin
-- ----------------------------------------------------------------------------
-- The first account to sign up becomes the admin.
--
-- Without this, a freshly migrated install is unusable: every new profile
-- defaults to 'bdr', which cannot open /control, so the owner has to reach for
-- a SQL console before they can administer their own app. That is a bad first
-- run and an easy way to get locked out.
--
-- The elevation is strictly one-shot. It only fires while NO active admin
-- exists, so the second user — and every user after — gets the ordinary
-- default. Re-running this migration cannot re-elevate anyone.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_count integer;
  assigned_role text := 'bdr';
begin
  -- Count admins BEFORE inserting, so the very first profile is the only one
  -- that can ever qualify.
  select count(*) into admin_count
  from public.user_profiles
  where role = 'admin' and is_active = true;

  if admin_count = 0 then
    assigned_role := 'admin';
  end if;

  insert into public.user_profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    assigned_role
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- Covers the case where a user was created before this migration ran: if the
-- install has profiles but no admin at all, promote the earliest one so the
-- app is never left with nobody able to administer it.
do $$
declare
  first_profile uuid;
begin
  if not exists (select 1 from public.user_profiles where role = 'admin' and is_active = true) then
    select id into first_profile
    from public.user_profiles
    order by created_at asc
    limit 1;

    if first_profile is not null then
      update public.user_profiles set role = 'admin' where id = first_profile;
    end if;
  end if;
end $$;
