-- ============================================================================
-- 20260729110000_own_google_auth
-- ----------------------------------------------------------------------------
-- Sign-in stops going through Supabase Auth. The app speaks to Google itself
-- and issues its own session.
--
-- What deliberately does NOT change: `auth.uid()`, and therefore every RLS
-- policy written against it. That function reads the `sub` claim of the JWT
-- PostgREST was handed — it never consulted `auth.users`. The session this app
-- now issues is signed with the same project JWT secret and carries the same
-- claims, so Postgres cannot tell the difference and no policy needed editing.
--
-- What does change is where a profile comes from. It used to be a side effect
-- of a row appearing in `auth.users`; now the application creates it, so:
--
--   * `user_profiles.id` stops being a foreign key into `auth.users` and
--     generates its own uuid. Existing rows keep the ids they have, which is
--     what makes this migration safe on a live install — every
--     `owner_user_id`, `assignee_id` and `from_user_id` still points at the
--     same person.
--   * the trigger on `auth.users` is dropped. It cannot fire again and would
--     be misleading to leave in place.
--   * the admission rule it carried moves into `admit_google_user`, called by
--     the sign-in route. Same rule, same allow-list, same one-shot first-admin
--     elevation — see 20260729100000_google_oauth for why each exists.
--
-- Keeping admission in SQL rather than TypeScript is deliberate: it is the one
-- decision that must hold even if a route is wrong, and `security definer`
-- means the caller cannot influence it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Detach from auth.users.
-- ----------------------------------------------------------------------------
do $$
declare
  fk_name text;
begin
  select conname into fk_name
  from pg_constraint
  where conrelid = 'public.user_profiles'::regclass
    and contype = 'f'
    and confrelid = 'auth.users'::regclass
  limit 1;

  if fk_name is not null then
    execute format('alter table public.user_profiles drop constraint %I', fk_name);
  end if;
end $$;

alter table public.user_profiles alter column id set default gen_random_uuid();

-- Google's account id, so a colleague who changes their display name or has
-- two addresses is still recognised as the same person.
alter table public.user_profiles add column if not exists google_sub text;

create unique index if not exists idx_user_profiles_google_sub
  on public.user_profiles (google_sub) where google_sub is not null;

-- Sign-in looks a person up by address on every visit; without this it is a
-- sequential scan of the whole table on the hot path.
create unique index if not exists idx_user_profiles_email_lower
  on public.user_profiles (lower(email)) where email is not null;

alter table public.user_profiles add column if not exists last_sign_in_at timestamptz;

comment on column public.user_profiles.google_sub is
  'Google account id from the verified id_token. Stable across name and address changes.';

-- ----------------------------------------------------------------------------
-- The trigger is now dead code. Dropping the function too would break the
-- older migrations'' idempotency, so it is left defined but detached.
-- ----------------------------------------------------------------------------
drop trigger if exists trg_auth_user_created on auth.users;

comment on function public.handle_new_user() is
  'Superseded by admit_google_user. Detached from auth.users in 20260729110000 — sign-in no longer creates rows there.';

-- ----------------------------------------------------------------------------
-- Admission, called once per sign-in.
--
-- Returns the profile id whether or not the account is active: an inactive
-- profile still has to be readable so the pending screen can name it.
-- ----------------------------------------------------------------------------
create or replace function public.admit_google_user(
  p_email text,
  p_full_name text default null,
  p_google_sub text default null,
  p_avatar_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_domain text;
  v_id uuid;
  v_admin_count integer;
  v_allowed text[];
  v_admitted boolean;
begin
  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'admit_google_user requires an email address';
  end if;

  -- Returning visitor. Matched on google_sub first: an address can be
  -- reassigned inside a workspace, a Google account id cannot.
  select id into v_id
  from public.user_profiles
  where (p_google_sub is not null and google_sub = p_google_sub)
     or lower(email) = v_email
  order by (google_sub is not null and google_sub = p_google_sub) desc
  limit 1;

  if v_id is not null then
    update public.user_profiles
    set google_sub = coalesce(p_google_sub, google_sub),
        full_name = coalesce(nullif(trim(coalesce(p_full_name, '')), ''), full_name),
        avatar_url = coalesce(p_avatar_url, avatar_url),
        email = coalesce(email, v_email),
        last_sign_in_at = now()
    where id = v_id;
    return v_id;
  end if;

  -- New account. The first one in is admin and active regardless of the
  -- allow-list, or a fresh install would have nobody able to administer it.
  select count(*) into v_admin_count
  from public.user_profiles
  where role = 'admin' and is_active = true;

  if v_admin_count = 0 then
    v_admitted := true;
  else
    select allowed_domains into v_allowed from public.auth_settings where id = 'default';
    v_domain := split_part(v_email, '@', 2);
    v_admitted := v_domain <> '' and v_allowed is not null and v_domain = any(v_allowed);
  end if;

  insert into public.user_profiles (email, full_name, role, is_active, google_sub, avatar_url, last_sign_in_at)
  values (
    v_email,
    coalesce(nullif(trim(coalesce(p_full_name, '')), ''), split_part(v_email, '@', 1)),
    case when v_admin_count = 0 then 'admin' else 'bdr' end,
    v_admitted,
    p_google_sub,
    p_avatar_url,
    now()
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.admit_google_user(text, text, text, text) is
  'Finds or creates the profile for a verified Google identity, applying the domain allow-list. Called only by the sign-in route, through the service role.';

-- Only the service role calls this — it is the sign-in path, and a signed-in
-- user has no reason to be able to mint profiles.
revoke all on function public.admit_google_user(text, text, text, text) from public;
revoke all on function public.admit_google_user(text, text, text, text) from anon;
revoke all on function public.admit_google_user(text, text, text, text) from authenticated;
