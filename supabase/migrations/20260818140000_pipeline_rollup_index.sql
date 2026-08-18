-- ============================================================================
-- 20260818140000_pipeline_rollup_index
-- ----------------------------------------------------------------------------
-- Give pipeline_rollup an index to read, because the table is 492MB.
--
-- The aggregate in 20260818120000 was the right move and it was not sufficient:
-- called on the real table it dies at the statement timeout.
--
--   select * from pipeline_rollup()   ->  8.8 s, 57014 canceling statement due
--                                          to statement timeout
--
-- So summarise_pipeline got SLOWER, not faster: it paid 8.8 s for the failed
-- aggregate and then fell back to walking the table anyway. 114 s measured, where
-- the old path alone was 64-81 s.
--
-- WHY. canonical_projects is 134 columns and roughly 4.7 KB a row — about 492 MB
-- across 109,552 rows. A GROUP BY with no usable index is a sequential scan of all
-- of it, and no aggregate can read half a gigabyte inside an 8-second budget. For
-- scale, a bare count(*) on this table takes 5.4 s even served by the primary key.
--
-- This is exactly what 20260811160000_disposition_rollup_rpc already wrote down:
-- "Without them every count is a sequential scan of the whole table, and no amount
-- of restructuring the client fixes that." That migration added indexes alongside
-- its GROUP BY. This one didn't, and repeated the mistake it documented.
--
-- Two changes.
--
-- 1. A COVERING INDEX over exactly the seven columns the rollup reads, so the
--    aggregate can be satisfied by an INDEX ONLY SCAN — ~10 MB of index instead of
--    ~492 MB of heap. Nothing else needs this index; it exists to make this one
--    query cheap.
--
-- 2. A LONGER statement_timeout on the function itself, as a backstop rather than
--    a fix. If the planner ever chooses the heap anyway — after bulk loading, say,
--    when the visibility map is stale and an index-only scan degrades to heap
--    fetches — a slow correct answer beats a failed one that silently falls back
--    to something slower still.
--
-- ON THE INTERACTION WITH THE INGEST WORK: an extra index is extra work on every
-- upsert, and the nightly ingest is currently fighting upsert timeouts, with
-- 20260813120000 dropping four indexes to relieve exactly that. This one is a
-- narrow btree of about 10 MB. The four that were dropped were GIN indexes over
-- jsonb, which cost orders of magnitude more to maintain per row. It is a real
-- cost and a small one, and it is the reason this index is deliberately minimal
-- rather than a comfortable superset.
-- ============================================================================

/*
  Column order follows how the rollup groups, though for an index-only scan what
  matters is only that every referenced column is PRESENT — Postgres can hash
  aggregate off the index in any order. Leading with current_phase also serves a
  future single-dimension rollup on the most-used axis without another index.

  `vertical` is a generated stored column, which is indexable like any other.
*/
create index if not exists idx_projects_rollup
  on canonical_projects (current_phase, priority_band, vertical, bu, icp_code, assignee_id, apollo_exported_at);

/*
  Recreated only to attach the timeout — the body is unchanged from
  20260818120000, and it is repeated in full rather than patched because
  `create or replace function` has no way to alter one attribute in isolation.

  30 s: comfortably more than an index-only scan of a 10 MB index needs, and still
  bounded, so a pathological plan fails rather than holding a connection open
  indefinitely.
*/
create or replace function public.pipeline_rollup()
returns table (
  current_phase text,
  priority_band text,
  vertical text,
  bu text,
  icp_code text,
  assigned boolean,
  exported boolean,
  n bigint
)
language sql
stable
security invoker
set search_path = public
set statement_timeout = '30s'
as $$
  select
    current_phase,
    priority_band,
    vertical,
    bu,
    icp_code,
    assignee_id is not null as assigned,
    apollo_exported_at is not null as exported,
    count(*) as n
  from canonical_projects
  group by 1, 2, 3, 4, 5, 6, 7;
$$;

grant execute on function public.pipeline_rollup() to authenticated;
grant execute on function public.pipeline_rollup() to service_role;
