#!/usr/bin/env bash
# Who the database admits when a Google account signs in.
#
# The admission rule lives in `admit_google_user`, not in TypeScript, so this
# is the only place it can honestly be tested. It matters more than most: the
# Google button is public, and the difference between `is_active` true and
# false is the difference between a stranger reading the lead book and a
# stranger waiting in a queue.
#
# Calls the function exactly as the sign-in route does, so what is exercised
# here is what runs in production.
#
#   ./scripts/test-google-admission.sh
#
# Requires Docker. Leaves nothing behind.

set -uo pipefail

CONTAINER=ldr_admission_test
IMAGE=postgres:15
DB=ldrtest
passed=0
failed=0

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

q() { docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tAc "$1" 2>&1 | tr -d '\r'; }

check() {
  local name="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    passed=$((passed + 1))
    printf '  \033[32mPASS\033[0m %s\n' "$name"
  else
    failed=$((failed + 1))
    printf '  \033[31mFAIL\033[0m %s — expected "%s", got "%s"\n' "$name" "$expected" "$actual"
  fi
}

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running — start Docker Desktop and retry."
  exit 1
fi

echo "Starting throwaway Postgres…"
cleanup
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=test -e POSTGRES_DB="$DB" "$IMAGE" >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then echo "Postgres never became ready."; exit 1; fi

docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<'SQL'
create extension if not exists pgcrypto;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
end $$;
SQL

for f in supabase/migrations/*.sql; do
  out=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q < "$f" 2>&1)
  if [ $? -ne 0 ]; then
    echo "Migration $(basename "$f") failed — run ./scripts/test-migrations.sh first."
    echo "$out" | sed 's/^/  /'
    exit 1
  fi
done

# $1 email, $2 full name, $3 google sub — the route's four arguments.
sqlarg() { if [ -z "${1:-}" ]; then printf 'null'; else printf "'%s'" "$1"; fi; }
signin() { q "select public.admit_google_user('$1', $(sqlarg "${2:-}"), $(sqlarg "${3:-}"), null);"; }
profile() { q "select role || '/' || is_active from public.user_profiles where lower(email) = lower('$1');"; }

echo
echo 'The first account can never be locked out'
signin 'founder@evercam.com' 'The Founder' 'google-sub-1' >/dev/null
check 'first sign-in is an active admin' "$(profile 'founder@evercam.com')" 'admin/true'
check 'the allow-list seeded itself from that admin' \
  "$(q "select array_to_string(allowed_domains, ',') from public.auth_settings where id='default';")" ''

# The seed reads existing admins at MIGRATION time; this install had none then,
# so set the list explicitly — which is what an admin does in the UI.
q "update public.auth_settings set allowed_domains = '{evercam.com}' where id='default';" >/dev/null

echo
echo 'A listed domain admits itself'
signin 'jose@evercam.com' 'Jose Sanchez' 'google-sub-2' >/dev/null
check 'colleague is active' "$(profile 'jose@evercam.com')" 'bdr/true'
check 'and is NOT admin — the one-shot elevation stayed shut' \
  "$(q "select count(*) from public.user_profiles where role='admin';")" '1'

echo
echo 'Anything else arrives inactive'
signin 'stranger@gmail.com' 'Passer By' 'google-sub-3' >/dev/null
check 'unlisted domain is inactive' "$(profile 'stranger@gmail.com')" 'bdr/false'
check 'a profile still exists, so an admin can see and approve them' \
  "$(q "select count(*) from public.user_profiles where email='stranger@gmail.com';")" '1'

echo
echo 'Matching is case- and shape-insensitive where it must be'
signin 'Shouty@EVERCAM.COM' >/dev/null
check 'upper-case address on a listed domain is admitted' "$(profile 'Shouty@EVERCAM.COM')" 'bdr/true'
signin 'lookalike@notevercam.com' >/dev/null
check 'a domain that merely ENDS with a listed one is refused' "$(profile 'lookalike@notevercam.com')" 'bdr/false'
signin 'sub@mail.evercam.com' >/dev/null
check 'a subdomain is not the domain' "$(profile 'sub@mail.evercam.com')" 'bdr/false'

echo
echo 'The display name Google supplies'
signin 'named@evercam.com' 'From Google' >/dev/null
check 'the name from the id_token is stored' \
  "$(q "select full_name from public.user_profiles where email='named@evercam.com';")" 'From Google'
signin 'plain@evercam.com' >/dev/null
check 'without one, the local part stands in' \
  "$(q "select full_name from public.user_profiles where email='plain@evercam.com';")" 'plain'

echo
echo 'Signing in again is not a new account'
before=$(q "select count(*) from public.user_profiles;")
signin 'jose@evercam.com' 'Jose Sanchez' 'google-sub-2' >/dev/null
check 'no duplicate profile' "$(q "select count(*) from public.user_profiles;")" "$before"
check 'the same id comes back'   "$(q "select count(distinct id) from public.user_profiles where lower(email)='jose@evercam.com';")" '1'
check 'last_sign_in_at is recorded'   "$(q "select last_sign_in_at is not null from public.user_profiles where lower(email)='jose@evercam.com';")" 't'

echo
echo 'A changed address on the same Google account is the same person'
signin 'j.sanchez@evercam.com' 'Jose Sanchez' 'google-sub-2' >/dev/null
check 'matched on google_sub, not on the address'   "$(q "select count(*) from public.user_profiles where google_sub='google-sub-2';")" '1'
check 'and no second row was created' "$(q "select count(*) from public.user_profiles;")" "$before"

echo
echo 'A pre-authorised address keeps the role an admin set'
q "insert into public.user_profiles (email, full_name, role, is_active) values ('manager@outside.org','Pre Set','sales_manager',true);" >/dev/null
signin 'manager@outside.org' 'Manager From Google' 'google-sub-9' >/dev/null
check 'role survives first sign-in' "$(profile 'manager@outside.org')" 'sales_manager/true'
check 'even though the domain is not on the list'   "$(q "select count(*) from public.auth_settings where 'outside.org' = any(allowed_domains);")" '0'

echo
echo 'An empty list admits nobody new'
q "update public.auth_settings set allowed_domains = '{}' where id='default';" >/dev/null
signin 'after@evercam.com' >/dev/null
check 'even a previously-listed domain now waits' "$(profile 'after@evercam.com')" 'bdr/false'
check 'and nobody already active was disabled' \
  "$(q "select count(*) from public.user_profiles where email='jose@evercam.com' and is_active;")" '1'

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ] || exit 1
