-- ============================================================================
-- 20260811160000_disposition_rollup_rpc
-- ----------------------------------------------------------------------------
-- Count the book once instead of thirty-five times.
--
-- getDispositionRollup asked PostgREST for a separate `count: exact, head: true`
-- per bucket: 4 priority bands, 5 completeness tiers, 20 route×stage lanes, plus
-- total, scored and routed. Thirty-five round trips, each a filtered count on an
-- unindexed column against 88,126 rows.
--
-- Measured, one at a time with nothing else running:
--   total (no filter)                      1,566 ms   -- any index will do
--   priority_band = 'P1'                   8,665 ms   -- FAILED, count null
--   source_completeness_tier = 'A'         9,491 ms   -- FAILED, count null
--
-- So each filtered count sits right on the statement timeout and falls either
-- side of it at random. Serialising them (an earlier fix) stopped sixteen from
-- competing but did not make any one of them fast, and the activity log recorded
-- the result plainly: `failedCounts=5` on every single run, ~22 s a time.
--
-- Two changes, because either alone is insufficient.
--
-- 1. INDEXES on the three predicates. Without them every count is a sequential
--    scan of the whole table, and no amount of restructuring the client fixes
--    that. These are plain rather than partial: unlike the ready-inventory index,
--    the selective part here IS the column, and every value of it is counted.
--
-- 2. A GROUP BY, so the vocabulary does not have to be enumerated by the client
--    at all. Beyond being one query instead of thirty-five, this fixes a
--    correctness bug: the client iterated ROUTES and STAGES from
--    src/lib/semantics.ts, so a route value in the data that was not in that
--    list was silently counted by nobody. A GROUP BY finds what is there.
-- ============================================================================

create index if not exists idx_projects_priority_band
  on canonical_projects (priority_band);

create index if not exists idx_projects_completeness_tier
  on canonical_projects (source_completeness_tier);

-- Composite, in the order the lane rollup groups: route first, then stage. Also
-- serves a count filtered on route alone, which a (stage, route) index would not.
create index if not exists idx_projects_route_stage
  on canonical_projects (route, stage);

/*
  One call, one JSON object.

  Returning json rather than a set of rows because the caller wants four
  differently-shaped rollups at once, and four SETOF functions would be four
  round trips again. The client reads keys off this and never has to know the
  vocabulary.

  STABLE, not VOLATILE, so the planner is free to treat it as a read.

  security invoker (the default, stated for the reader's benefit): this must not
  see more than the caller could. It is a pure aggregate over a table the
  authenticated role can already select from, so there is nothing to escalate,
  and making it definer would grant a way to count rows RLS might otherwise
  hide.
*/
create or replace function public.disposition_rollup()
returns json
language sql
stable
security invoker
set search_path = public
as $$
  select json_build_object(
    'total', (select count(*) from canonical_projects),
    'scored', (select count(*) from canonical_projects where priority_score is not null),
    'routed', (select count(*) from canonical_projects where routed_at is not null),

    -- Nulls excluded: an unscored record is not a band, and counting it under one
    -- would inflate whichever bucket null sorted into.
    'by_band', (
      select coalesce(json_agg(json_build_object('band', priority_band, 'count', n) order by n desc), '[]'::json)
      from (
        select priority_band, count(*) as n
        from canonical_projects
        where priority_band is not null
        group by priority_band
      ) b
    ),

    'by_tier', (
      select coalesce(json_agg(json_build_object('tier', source_completeness_tier, 'count', n) order by n desc), '[]'::json)
      from (
        select source_completeness_tier, count(*) as n
        from canonical_projects
        where source_completeness_tier is not null
        group by source_completeness_tier
      ) t
    ),

    /*
      Lanes need both columns set to mean anything -- a record with a route and no
      stage has not been routed, it is half-written, and giving it a lane would
      claim a disposition nobody chose.
    */
    'by_lane', (
      select coalesce(json_agg(json_build_object('route', route, 'stage', stage, 'count', n) order by n desc), '[]'::json)
      from (
        select route, stage, count(*) as n
        from canonical_projects
        where route is not null and stage is not null
        group by route, stage
      ) l
    ),

    -- The newest routing stamp, so the caller does not need a separate ordered
    -- read for it either.
    'last_routed', (select max(routed_at) from canonical_projects)
  );
$$;

-- Callable by a signed-in user. It aggregates a table they can already read.
grant execute on function public.disposition_rollup() to authenticated;
grant execute on function public.disposition_rollup() to service_role;
