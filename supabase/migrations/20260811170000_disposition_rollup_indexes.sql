-- ============================================================================
-- 20260811170000_disposition_rollup_indexes
-- ----------------------------------------------------------------------------
-- Finish indexing disposition_rollup(). The previous migration indexed three of
-- its predicates and left four unindexed, so the function landed right on the
-- statement timeout instead of under it.
--
-- Measured after 20260811160000, via PostgREST:
--   service_role   run 1   8,780 ms   FAILED, statement timeout
--   service_role   run 2   9,025 ms   FAILED, statement timeout
--   authenticated  run 1   8,016 ms   ok
--   authenticated  run 2   3,497 ms   ok   (warm cache)
--
-- Two things worth reading off that. The timeout is about eight seconds and it
-- applies to the SERVICE role too — so escalating the client would not have
-- helped, and the earlier assumption that the service key has no ceiling was
-- wrong. And the warm run at 3.5 s shows the query plan is fine; what costs the
-- other 4.5 s is reading pages that an index would not need to touch.
--
-- The function runs seven subqueries. Three were indexed:
--   group by priority_band              -- idx_projects_priority_band
--   group by source_completeness_tier   -- idx_projects_completeness_tier
--   group by route, stage               -- idx_projects_route_stage
-- Four were not:
--   count(*) where priority_score is not null
--   count(*) where routed_at is not null
--   max(routed_at)
--   count(*)                            -- served by any index, fine already
--
-- So three full scans of 88,126 rows remained, which is the residual cost.
--
-- PARTIAL indexes here, unlike the previous migration's plain ones. The
-- difference is what is being asked: those GROUP BY every value of a column, so
-- the index must hold every row. These count only the NON-NULL rows, so the
-- index only needs those — and both columns are null for a large share of the
-- table (65,324 of 88,126 are scored, so roughly a quarter are not). A partial
-- index is smaller, and being smaller is the entire point when the cost being
-- removed is page reads.
-- ============================================================================

create index if not exists idx_projects_priority_score_set
  on canonical_projects (priority_score)
  where priority_score is not null;

/*
  Plain ascending. A descending index would buy nothing here: Postgres scans a
  btree in either direction at the same cost, so `max(routed_at)` is one step off
  the end of an ascending index just as it is off the front of a descending one.
  Adding `desc` would only make this index unusable for an ascending sort that
  something else might want later.
*/
create index if not exists idx_projects_routed_at
  on canonical_projects (routed_at)
  where routed_at is not null;
