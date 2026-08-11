-- ============================================================================
-- 20260811140000_app_events
-- ----------------------------------------------------------------------------
-- One place that records what the app actually did.
--
-- Every silent failure found in this codebase so far had the same shape: a read
-- failed, the failure went to console.warn, and the caller wrote `?? 0`. So the
-- page rendered a zero and nobody could tell the difference between "no rows
-- match" and "the query never finished". console.warn only exists in a
-- serverless log stream that nobody tails and that rolls off, so after the fact
-- there was nothing left to look at.
--
-- The per-domain run tables (ingestion_runs, enrichment_runs, export_runs,
-- prioritisation_runs, cron_runs) each record the OUTCOME of a job. They do not
-- record the reads that fed it, the filters an operator applied, or the step
-- inside a composite job that failed. This table is for those: cross-cutting
-- events, one row each, queryable after the fact.
--
-- It deliberately does NOT replace the run tables. They carry domain columns
-- (records_ingested, credits_spent) that a generic jsonb column would make
-- awkward to aggregate.
--
-- WHAT MUST NOT GO IN HERE
-- ------------------------
-- Lead data. `detail` is for filter parameters, durations, row counts and error
-- text — never contact details. The writer redacts email- and phone-shaped
-- strings before insert, because an error message from an enrichment call can
-- easily quote the record it was working on, and a log with contact details in
-- it becomes a second copy of the CRM with weaker access rules.
-- ============================================================================

create table if not exists public.app_events (
  id bigserial primary key,

  -- Coarse bucket, so the log can be read one concern at a time. Kept as text
  -- rather than an enum: a new kind should not need a migration, and an
  -- unrecognised kind should still land rather than throw away the event.
  kind text not null,

  -- What happened, e.g. 'disposition_rollup' or 'records.filter'. Stable
  -- identifiers rather than sentences, so they group.
  name text not null,

  -- False for a failure. Nullable for events that are neither — an operator
  -- applying a filter has no success or failure.
  ok boolean,

  duration_ms integer,

  -- Filter parameters, counts, error text. Redacted before insert.
  detail jsonb not null default '{}'::jsonb,

  -- Who caused it. Null for scheduled work, which has no user.
  actor text,

  at timestamptz not null default now()
);

-- Reading the log means "newest first", almost always narrowed by kind.
create index if not exists idx_app_events_at on public.app_events (at desc);
create index if not exists idx_app_events_kind_at on public.app_events (kind, at desc);

-- Failures are the reason this table exists and are a small fraction of the
-- rows, so they get a partial index rather than being found by scanning.
create index if not exists idx_app_events_failures on public.app_events (at desc)
  where ok = false;

alter table public.app_events enable row level security;

-- Readable by signed-in users; the route still checks the permission. Writes go
-- through the service key only, so a browser session cannot forge an event.
drop policy if exists app_events_select on public.app_events;
create policy app_events_select on public.app_events
  for select to authenticated using (true);

-- --------------------------------------------------------------------------
-- Retention
-- --------------------------------------------------------------------------
-- This table takes a row per notable event, so it grows without bound and
-- nothing would ever delete from it. A log that fills the database is a worse
-- problem than the one it was added to solve, so the daily job calls this and
-- old rows go.
--
-- Failures are kept longer than successes: a slow query from six weeks ago is
-- noise, but a failure from six weeks ago may be the first instance of
-- something still happening.
create or replace function public.prune_app_events(
  keep_days integer default 30,
  keep_failure_days integer default 90
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.app_events
   where (ok is not false and at < now() - make_interval(days => keep_days))
      or (ok is false and at < now() - make_interval(days => keep_failure_days));
  get diagnostics removed = row_count;
  return removed;
end;
$$;
