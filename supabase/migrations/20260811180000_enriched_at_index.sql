-- ============================================================================
-- 20260811180000_enriched_at_index
-- ----------------------------------------------------------------------------
-- Make the spend rails measurable.
--
-- Every enrichment run is gated by two counts over `enriched_at` — a daily cap
-- and a 30-day cap — plus the monthly production target. None of them was
-- indexed, so each was a sequential scan of 88,126 rows and each exceeded the
-- ~8 s statement timeout.
--
-- Measured: `select count(*) where enriched_at >= now() - 1 day` did not return
-- at all; it was cancelled by the statement timeout. getProductionState reported
-- `produced: 0` alongside the warning "Could not measure this month's
-- production:" — with an EMPTY error message, which is what a cancelled
-- statement looks like from PostgREST.
--
-- The direction of the failure is what makes this urgent rather than merely
-- untidy. getEnrichedSinceCount ends `if (error) return 0`, and the caller reads
-- that as "nothing has been enriched", so:
--
--   rails = [{ used: 0, cap: 600 }, { used: 0, cap: 10000 }]
--
-- A cap whose usage always reads zero is not a cap. Both spend rails have been
-- open for as long as the table has been too big to scan, and the only reason
-- that has not cost money is that the same failure suppresses the batch in other
-- ways. This is the one place in the app where a silent zero spends money rather
-- than just misreporting.
--
-- Partial, because only enriched rows are ever counted and roughly a quarter of
-- the table has no enriched_at at all. Smaller index, and it grows only with
-- work actually done.
-- ============================================================================

create index if not exists idx_projects_enriched_at
  on canonical_projects (enriched_at)
  where enriched_at is not null;
