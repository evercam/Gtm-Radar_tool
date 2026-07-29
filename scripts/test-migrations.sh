#!/usr/bin/env bash
# Applies every migration to a throwaway Postgres, in filename order, and
# reports the first failure with its line.
#
# This exists because migrations were previously reviewed by eye and shipped
# unvalidated — which cost two failed runs against a live database. Run this
# before handing any new migration over.
#
#   ./scripts/test-migrations.sh
#
# Requires Docker. Leaves nothing behind.

set -uo pipefail

CONTAINER=ldr_migration_test
IMAGE=postgres:15
DB=ldrtest

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running — start Docker Desktop and retry."
  exit 1
fi

echo "Starting throwaway Postgres…"
cleanup
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=test -e POSTGRES_DB="$DB" "$IMAGE" >/dev/null

# `pg_isready` is not enough: the postgres image starts a TEMPORARY server on a
# unix socket to run its init scripts, and pg_isready happily reports that one
# as ready moments before it is shut down and the real server starts. Poll with
# an actual query instead.
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "Postgres never became ready."
  docker logs "$CONTAINER" 2>&1 | tail -20
  exit 1
fi

# Supabase provides these; the migrations reference auth.uid() and auth.users.
# Stubbing them is enough to prove the SQL parses and the types line up.
setup_out=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q 2>&1 <<'SQL' 
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
)
if [ $? -ne 0 ]; then
  echo "Harness setup failed — the results below would be meaningless:"
  echo "$setup_out" | sed 's/^/  /'
  exit 1
fi

# Prove the stubs are really there. A silently-failed setup previously showed
# up as a bogus migration failure ("role anon does not exist").
for role in anon authenticated; do
  if ! docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc       "select 1 from pg_roles where rolname='$role'" | grep -q 1; then
    echo "Harness setup incomplete: role '$role' was not created."
    exit 1
  fi
done

echo "Applying migrations…"
failed=0
for f in supabase/migrations/*.sql; do
  name=$(basename "$f")
  out=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q < "$f" 2>&1)
  if [ $? -eq 0 ]; then
    printf '  \033[32mOK\033[0m   %s\n' "$name"
  else
    printf '  \033[31mFAIL\033[0m %s\n' "$name"
    echo "$out" | sed 's/^/         /'
    failed=1
    break
  fi
done

if [ "$failed" -eq 0 ]; then
  echo
  echo "Re-applying to prove idempotency…"
  for f in supabase/migrations/*.sql; do
    out=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q < "$f" 2>&1)
    if [ $? -ne 0 ]; then
      printf '  \033[31mNOT IDEMPOTENT\033[0m %s\n' "$(basename "$f")"
      echo "$out" | sed 's/^/         /'
      failed=1
      break
    fi
  done
  [ "$failed" -eq 0 ] && echo "  all migrations re-applied cleanly"
fi

echo
[ "$failed" -eq 0 ] && echo "All migrations apply and are idempotent." || echo "Migration check failed."
exit "$failed"
