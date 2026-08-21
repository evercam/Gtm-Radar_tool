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
#
# TWO PASSES, BECAUSE ONE PASS PASSED A BROKEN MIGRATION
#
# 20260821140000 batched an update in a DO loop with `commit` between chunks. It
# was green here, and against production raised `invalid transaction termination`
# and rolled back the whole file, functions included — changing nothing while
# looking like it had. Two blind spots let that through, and both are closed here:
#
#   HOW IT IS RUN. psql runs in autocommit; the Supabase SQL editor wraps a script
#     in one transaction, where COMMIT inside plpgsql is an error. Pass 2 wraps
#     each file in BEGIN/COMMIT.
#
#   WHETHER THERE IS ANY DATA. The database was empty, so a migration that
#     transforms existing rows had nothing to transform and passed by doing
#     nothing — its data path never executed at all. Both passes now seed fixture
#     rows as soon as canonical_projects exists, so later migrations meet rows.
#
# Neither alone would have caught it: the commit was only reached when a row
# matched, and the error was only raised inside a transaction.

set -uo pipefail

IMAGE=postgres:15
DB=ldrtest
CONTAINERS=""

cleanup() {
  for c in $CONTAINERS; do docker rm -f "$c" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running — start Docker Desktop and retry."
  exit 1
fi

# Supabase provides these; the migrations reference auth.uid() and auth.users.
# Stubbing them is enough to prove the SQL parses and the types line up.
HARNESS_SQL=$(cat <<'SQL'
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
  -- service_role was missing, and it is the reason this whole check was red from
  -- 20260811160000_disposition_rollup_rpc.sql onward: every run failed with "role
  -- service_role does not exist" and stopped there, so the migrations after it
  -- were never validated by anything.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
SQL
)

# One row per classification branch a migration is likely to touch. Small on
# purpose: this proves the data path RUNS, not that it scales.
FIXTURE_SQL=$(cat <<'SQL'
insert into public.canonical_projects (source_key, source_unique_id, canonical_name, record_type, bu, country_code, building_type)
values
  ('sec_edgar', 'fixture-filing', 'ACME CORP filing',   'filing',  'export',  'US', null),
  ('gem',       'fixture-solar',  'Fixture Solar Farm', 'project', 'usa',     'US', 'Solar'),
  ('ted',       'fixture-tender', 'Fixture Tender',     'tender',  'uk',      'GB', null),
  ('permits',   'fixture-permit', 'Fixture Permit',     'permit',  'ireland', 'IE', null),
  ('rss',       'fixture-news',   'Fixture News',       'news',    'export',  'US', null)
on conflict do nothing;
SQL
)

start_db() {
  local name=$1
  docker rm -f "$name" >/dev/null 2>&1
  CONTAINERS="$CONTAINERS $name"
  docker run -d --name "$name" -e POSTGRES_PASSWORD=test -e POSTGRES_DB="$DB" "$IMAGE" >/dev/null

  # `pg_isready` is not enough: the postgres image starts a TEMPORARY server on a
  # unix socket to run its init scripts, and pg_isready happily reports that one
  # as ready moments before it is shut down and the real server starts. Poll with
  # an actual query instead.
  local ready=0
  for _ in $(seq 1 60); do
    if docker exec "$name" psql -U postgres -d "$DB" -tAc 'select 1' >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "Postgres never became ready."
    docker logs "$name" 2>&1 | tail -20
    return 1
  fi

  local setup_out
  setup_out=$(printf '%s\n' "$HARNESS_SQL" | docker exec -i "$name" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q 2>&1)
  if [ $? -ne 0 ]; then
    echo "Harness setup failed — the results below would be meaningless:"
    echo "$setup_out" | sed 's/^/  /'
    return 1
  fi
  # Prove the stubs are really there. A silently-failed setup previously showed up
  # as a bogus migration failure ("role anon does not exist").
  for role in anon authenticated service_role; do
    if ! docker exec "$name" psql -U postgres -d "$DB" -tAc "select 1 from pg_roles where rolname='$role'" | grep -q 1; then
      echo "Harness setup incomplete: role '$role' was not created."
      return 1
    fi
  done
  return 0
}

# Apply every migration in order. mode=plain feeds each file to psql as-is;
# mode=tx wraps it in BEGIN/COMMIT the way the SQL editor does. Seeds the fixture
# the moment canonical_projects exists, so every later migration meets rows.
apply_all() {
  local name=$1 mode=$2 label=$3
  local seeded=0 out rc n
  echo "$label"
  for f in supabase/migrations/*.sql; do
    if [ "$mode" = "tx" ]; then
      out=$( { echo "begin;"; cat "$f"; echo "commit;"; } | docker exec -i "$name" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q 2>&1 )
    else
      out=$(docker exec -i "$name" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q < "$f" 2>&1)
    fi
    rc=$?
    if [ $rc -ne 0 ]; then
      printf '  \033[31mFAIL\033[0m %s\n' "$(basename "$f")"
      echo "$out" | sed 's/^/         /'
      if [ "$mode" = "tx" ]; then
        echo "         (psql autocommit hides this; the Supabase SQL editor does not)"
      fi
      return 1
    fi
    printf '  \033[32mOK\033[0m   %s\n' "$(basename "$f")"

    if [ "$seeded" -eq 0 ] && docker exec "$name" psql -U postgres -d "$DB" -tAc "select to_regclass('public.canonical_projects')" 2>/dev/null | grep -q canonical_projects; then
      printf '%s\n' "$FIXTURE_SQL" | docker exec -i "$name" psql -U postgres -d "$DB" -q >/dev/null 2>&1
      n=$(docker exec "$name" psql -U postgres -d "$DB" -tAc "select count(*) from public.canonical_projects" 2>/dev/null | tr -d '\r')
      seeded=1
      if [ "${n:-0}" -lt 5 ]; then
        printf '  \033[33mnote\033[0m fixture rows not seeded (%s/5) — data paths below are UNTESTED\n' "${n:-0}"
      else
        printf '       seeded %s fixture rows — migrations below meet real data\n' "$n"
      fi
    fi
  done
  return 0
}

failed=0

echo "Pass 1/2 — psql autocommit"
start_db ldr_migration_test || exit 1
apply_all ldr_migration_test plain "Applying migrations..." || failed=1

if [ "$failed" -eq 0 ]; then
  echo
  echo "Re-applying to prove idempotency..."
  for f in supabase/migrations/*.sql; do
    out=$(docker exec -i ldr_migration_test psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q < "$f" 2>&1)
    if [ $? -ne 0 ]; then
      printf '  \033[31mNOT IDEMPOTENT\033[0m %s\n' "$(basename "$f")"
      echo "$out" | sed 's/^/         /'
      failed=1
      break
    fi
  done
  if [ "$failed" -eq 0 ]; then echo "  all migrations re-applied cleanly"; fi
fi

# Pass 2 needs its OWN database. Replaying against pass 1's would find every
# transformation already done and every data path a no-op — which is the blind
# spot this pass exists to close, not one to reproduce.
if [ "$failed" -eq 0 ]; then
  echo
  echo "Pass 2/2 — fresh database, each file wrapped in BEGIN/COMMIT like the SQL editor"
  start_db ldr_migration_test_tx || exit 1
  apply_all ldr_migration_test_tx tx "Applying migrations inside transactions..." || failed=1
fi

echo
if [ "$failed" -eq 0 ]; then
  echo "All migrations apply, are idempotent, and survive a wrapping transaction."
else
  echo "Migration check failed."
fi
exit "$failed"
