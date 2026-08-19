-- ============================================================================
-- 20260819120000_setup_state_rollup_index
-- ----------------------------------------------------------------------------
-- Give setup_state_rollup an index to read, because the table is 492MB.
--
-- THIS IS THE THIRD TIME. 20260818140000 fixed exactly this for pipeline_rollup and
-- said so in as many words:
--
--   "This is exactly what 20260811160000_disposition_rollup_rpc already wrote down:
--    'Without them every count is a sequential scan of the whole table, and no
--    amount of restructuring the client fixes that.' That migration added indexes
--    alongside its GROUP BY. This one didn't, and repeated the mistake it
--    documented."
--
-- 20260819100000 then repeated it again. Measured on the real table:
--
--   select * from setup_state_rollup()  ->  canceling statement due to statement
--                                           timeout
--
-- The reasoning that produced it was sound and the evidence was misread. The
-- argument was "pipeline_rollup computes a full grouped aggregate in 1.5 s, so a
-- single scan with eleven FILTER clauses will be about as quick" — but 1.5 s was
-- never a property of the aggregate. It was the property of idx_projects_rollup,
-- added by the migration above precisely because the un-indexed version died at the
-- timeout. The benchmark had an index behind it and the new function did not.
--
-- canonical_projects is 134 columns and roughly 4.7 KB a row — about 492 MB across
-- 111,353 rows. No aggregate reads half a gigabyte inside an 8-second budget.
--
-- AND IT MADE THE PAGE SLOWER, which is the same secondary failure 20260818140000
-- recorded: /control/team paid the timeout and then fell back to the eleven counts
-- anyway. Twice, in fact, because the rollup was called from two places on the same
-- render. That is fixed in the page alongside this.
-- ============================================================================

/*
  A covering index over exactly the nine columns setup_state_rollup reads, so the
  whole thing is satisfied by an INDEX ONLY SCAN — tens of MB of index instead of
  492 MB of heap.

  PLAIN COLUMNS, not boolean expressions. Indexing `(contact_email is not null)` and
  friends would be perhaps a quarter of the size, and it would make an index-only
  scan contingent on the planner matching each expression to the FILTER clause that
  uses it. When that match fails there is no error — it silently reads the heap and
  dies at the timeout, which is the failure this migration exists to stop happening
  a third time. The proven shape from idx_projects_rollup is plain columns, so this
  uses plain columns.

  ON INGEST COST, in the same terms 20260818140000 used: this is another narrow
  btree, ~15 MB, and the nightly ingest is already fighting upsert timeouts —
  20260813120000 dropped four indexes to relieve exactly that. Those were GIN over
  jsonb and cost orders of magnitude more per row than this does. It is a real cost
  and a small one, and it is why this index is exactly the nine columns rather than
  a comfortable superset.

  status leads because it is the only column here with more than two meaningful
  values, and two of the eleven counts filter on a specific one.
*/
create index if not exists idx_projects_setup_state
  on canonical_projects (
    status,
    priority_band,
    route,
    assignee_id,
    apollo_exported_at,
    email_verified,
    owner_user_id,
    contact_phone,
    contact_email
  );

/*
  Recreated to attach the timeout and the grants — the counting body is unchanged
  from 20260819100000, and repeated in full because `create or replace function` has
  no way to alter one attribute in isolation.

  Three things the first version should have carried, all copied from the shape
  pipeline_rollup settled on:

    statement_timeout = '30s'  a backstop, not a fix. If the planner ever chooses the
                               heap anyway — after a bulk load, when the visibility
                               map is stale and an index-only scan degrades to heap
                               fetches — a slow correct answer beats a failure that
                               falls back to something slower still.
    security invoker           the caller's rights, not the definer's. This reads a
                               table the caller can already read; borrowing definer
                               rights would widen that for nothing.
    set search_path = public   so the table it counts cannot be shadowed by whatever
                               search_path the caller happens to arrive with.

  Explicit grants for the same reason: EXECUTE defaults to PUBLIC, which works and
  says nothing about intent.
*/
create or replace function public.setup_state_rollup()
returns table (
  total bigint,
  scored bigint,
  routed bigint,
  enriched bigint,
  assigned bigint,
  exported bigint,
  with_phone bigint,
  with_email bigint,
  verified bigint,
  queued bigint,
  unassigned_open bigint
)
language sql
stable
parallel safe
security invoker
set search_path = public
set statement_timeout = '30s'
as $$
  select
    count(*)                                                        as total,
    count(*) filter (where priority_band is not null)               as scored,
    count(*) filter (where route is not null)                       as routed,
    count(*) filter (where status = 'ENRICHED')                     as enriched,
    count(*) filter (where assignee_id is not null)                 as assigned,
    count(*) filter (where apollo_exported_at is not null)          as exported,
    count(*) filter (where contact_phone is not null)               as with_phone,
    count(*) filter (where contact_email is not null)               as with_email,
    count(*) filter (where email_verified is true)                  as verified,
    count(*) filter (where status = 'PENDING_ENRICHMENT')           as queued,
    /*
      Reproduces the old PostgREST predicate exactly, including its treatment of
      NULL: `status not in (…)` evaluates to NULL when status is NULL, so such a row
      is EXCLUDED, and `.not('status','in',…)` did the same. Verified against the
      live table at 0 such rows, so this cannot move the tile.
    */
    count(*) filter (
      where owner_user_id is null
        and status not in ('CONVERTED', 'LOST')
    )                                                               as unassigned_open
  from canonical_projects;
$$;

grant execute on function public.setup_state_rollup() to authenticated;
grant execute on function public.setup_state_rollup() to service_role;
