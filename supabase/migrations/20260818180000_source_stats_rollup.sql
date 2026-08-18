-- ============================================================================
-- 20260818180000_source_stats_rollup
-- ----------------------------------------------------------------------------
-- The last of the whole-table walks: 75.8 seconds to produce one row per source.
--
-- getSourceStats reads all 109,552 rows to answer "how much has each source
-- contributed, how complete is it, and when did it last deliver" — about 25 rows
-- of output. It is the slowest tool on the MCP endpoint (list_sources) and the
-- reason the last two test-mcp checks fail against their 60-second ceiling.
--
-- Same fix as dashboard_rollup and pipeline_rollup, and the least risky of the
-- three: there is no derived state here, just a count, a sum and a max.
--
-- WHY THIS RETURNS A SUM AND A COUNT RATHER THAN AN AVERAGE. The caller divides
-- and rounds, and it must keep doing so, because its average is not the average a
-- reader would assume: `sum += Number(population_percentage) || 0` counts a NULL
-- completeness as a zero and still divides by every row. Computing avg() here
-- would silently skip the nulls instead, which is arguably more correct and is
-- definitely a different number — and changing a dashboard figure while claiming
-- to make it faster is how a performance fix becomes a data bug. If that
-- definition should change, it should change on purpose, in one place, in TypeScript.
-- ============================================================================

/*
  A narrow index for these three columns, so the aggregate is an index-only scan
  over a few MB rather than a sequential scan of a 492 MB heap. Without it this
  cannot finish inside the 8-second statement timeout — that is exactly how
  pipeline_rollup failed on its first attempt (57014, at 8.8 s).

  A SEPARATE index rather than widening idx_projects_rollup_wide, deliberately.
  Postgres cannot add columns to an existing index, so widening means dropping and
  rebuilding it: a full rebuild on a 492 MB table, holding a write lock, during
  which the dashboard loses the index it now depends on. Three more columns are not
  worth that. This one is ~5 MB.

  It does mean a second index maintained on every upsert while the nightly ingest
  is still fighting write timeouts. Small — a narrow btree, against the four GIN
  indexes over jsonb that 20260813120000 dropped to relieve exactly that — but real,
  and the reason it covers three columns rather than a comfortable superset.
*/
create index if not exists idx_projects_source_stats
  on canonical_projects (source_key, population_percentage, created_at);

/*
  One row per source.

  `n` and `completeness_sum` are returned raw for the reason set out above. `last_ingested`
  is max(created_at), which is what the caller means by "last delivered" — the newest
  record the source produced, not the newest ingestion RUN, since a run that fetched
  nothing delivered nothing.

  STABLE and security invoker, like its siblings: a pure aggregate over a table the
  caller can already read, so there is nothing to escalate. statement_timeout raised
  as a backstop for a stale visibility map after a bulk load, when an index-only scan
  degrades to heap fetches — a slow correct answer beating a failure.
*/
create or replace function public.source_stats()
returns table (
  source_key text,
  n bigint,
  completeness_sum numeric,
  last_ingested timestamptz
)
language sql
stable
security invoker
set search_path = public
set statement_timeout = '30s'
as $$
  select
    source_key,
    count(*) as n,
    -- coalesce, not sum-ignoring-nulls: matches `Number(x) || 0` in the caller.
    sum(coalesce(population_percentage, 0))::numeric as completeness_sum,
    max(created_at) as last_ingested
  from canonical_projects
  group by source_key;
$$;

grant execute on function public.source_stats() to authenticated;
grant execute on function public.source_stats() to service_role;
