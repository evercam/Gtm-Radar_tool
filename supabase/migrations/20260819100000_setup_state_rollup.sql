-- ============================================================================
-- 20260819100000_setup_state_rollup
-- ----------------------------------------------------------------------------
-- Eleven counts in one pass, for /control/team.
--
-- readSetupState fires ten `count: 'exact', head: true` queries in parallel and
-- getTeamLoad fires an eleventh. Measured today against 111,353 rows:
--
--   count(*) UNFILTERED                  9.4 s cold, 7.6 s warm
--   count(*) where priority_band not null    1.7 s
--   count(*) where status = 'ENRICHED'       0.9 s
--   the unassigned count (status not in + owner is null)  6.7 s
--   ten of them, in parallel                 9.7 s
--
--   pipeline_rollup() — a FULL GROUPED AGGREGATE   1.5 s
--
-- That last line is the whole argument. Computing an entire grouped rollup
-- server-side is six times faster than one unfiltered count, so the database is
-- not slow — the page is asking it the wrong way, eleven times over. The filtered
-- counts are cheap because they use indexes; `count(*)` with no predicate has to
-- visit every tuple, and there is no index that shortcuts it.
--
-- Parallelism did not save it and could not: ten queries that each scan the same
-- table contend for the same buffers, which is why ten-in-parallel (9.7 s) is barely
-- better than the single worst one (9.4 s).
--
-- So they become ONE sequential scan with eleven FILTER clauses. Postgres reads each
-- row once and increments whichever counters match.
--
-- WHY A SQL AGGREGATE HERE, and not a snapshot like kpi_snapshots. There is no
-- TypeScript to duplicate: these are eleven plain predicates over one table, each
-- already expressed as a PostgREST filter, with no funnel logic, no wall-clock
-- comparison and no derived stage. Re-expressing `status = 'ENRICHED'` in SQL creates
-- no second definition of anything. kpi_snapshots exists because its several hundred
-- lines of funnel derivation could not move without being forked; nothing here is in
-- that position, and a live exact answer beats a stale one when it costs 1.5 s.
--
-- Exactness is preserved. Every row is still counted, once, where the rows already
-- are.
-- ============================================================================

/*
  One row, eleven columns.

  bigint throughout because count() returns bigint; the caller converts. Named to
  match the destructured names in readSetupState so the mapping is obvious at the
  call site rather than positional.

  STABLE, not IMMUTABLE: the answer depends on table contents, so it may be cached
  within a statement but never across them.
*/
create or replace function setup_state_rollup()
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
      getTeamLoad's unassigned pool, folded into the same pass. It lived in its own
      query and cost 6.7 s alone.

      WRITTEN TO MATCH THE OLD PREDICATE EXACTLY, including its treatment of NULL.
      `status not in ('CONVERTED','LOST')` evaluates to NULL when status is NULL, so
      such a row is EXCLUDED — and PostgREST's `.not('status','in',…)` did the same.
      Verified against the live table: 0 rows currently have a NULL status, so the two
      readings agree today and this cannot move the tile.

      Worth knowing which way it would move if one appeared: this tile warns about
      unowned work, and its recorded bug was reading 1,000 while 22,438 leads sat
      unowned — so UNDER-counting is the dangerous direction, and excluding NULLs
      under-counts. Left as-is rather than corrected here, because changing a number
      while optimising the query that produces it makes both changes unreviewable.
      If NULL statuses ever become possible, this predicate is the thing to revisit.
    */
    count(*) filter (
      where owner_user_id is null
        and status not in ('CONVERTED', 'LOST')
    )                                                               as unassigned_open
  from canonical_projects;
$$;
