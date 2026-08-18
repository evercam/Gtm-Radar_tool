-- ============================================================================
-- 20260818120000_pipeline_rollup_rpc
-- ----------------------------------------------------------------------------
-- Count 109,552 rows in the database instead of shipping them to Node.
--
-- summarise_pipeline pulled the WHOLE table across the wire to compute twelve
-- group totals. Measured today against 109,552 rows: 64 s, 72 s, 81 s on three
-- runs. Two separate faults, and fixing either alone leaves it broken.
--
-- 1. OFFSET PAGING. `pageAll` walked the table with `.range(p*1000, …)`, and
--    offset paging asks Postgres to produce and discard every row before the
--    window — so page 110 pays for the previous 109,000 and the total cost grows
--    with the square of the table. queries.ts already learned this in
--    getSourceStats and switched to keyset (`id > last`); the MCP helper never
--    got the fix.
--
-- 2. TRANSFERRING THE ROWS AT ALL. Even with keyset paging, 110 sequential
--    round trips at ~700 ms is ~77 s. The client wants twelve numbers. Nothing
--    about that requires 109,552 rows to leave the database, and no amount of
--    restructuring the pagination changes the arithmetic.
--
-- So the grouping moves into SQL. One round trip, one hash aggregate.
--
-- WHY THIS GROUPS BY THE RAW COLUMNS rather than the values the tool reports:
-- phase and party are normalised in TypeScript, not in SQL. 117 raw phase
-- strings map to 11 values through an exact table plus regex rules in
-- lib/phase.ts, and that mapping is not invertible — there is no list of raw
-- values to put in a WHERE clause. So this returns counts grouped by the raw
-- columns, and the caller folds them into the normalised vocabulary. The number
-- of distinct combinations is in the thousands at most, against 109,552 rows,
-- and it keeps ONE definition of what a phase is instead of a second one here
-- that would drift from the first.
--
-- Exactness is preserved. Every row is still counted; the counting just happens
-- where the rows already are. The caller's `truncated` flag becomes permanently
-- false on this path, because there is no page cap to hit.
-- ============================================================================

/*
  One row per distinct combination, with the two derived booleans the caller
  needs.

  `assigned` and `exported` are computed here rather than returned as the
  underlying timestamp/uuid so that the group key stays small: grouping by
  assignee_id would return a row per person per combination and defeat the point.
  The caller only ever asks "how many of these are assigned", never "to whom".

  STABLE, not VOLATILE, so the planner may treat it as a read.

  security invoker, stated rather than left implicit: this must not see more than
  the caller could. It is a pure aggregate over a table the authenticated role can
  already select from, so there is nothing to escalate — and making it definer
  would hand out a way to count rows that RLS might otherwise hide.
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

-- Callable by a signed-in user, and by the service role the MCP endpoint uses.
-- It aggregates a table they can already read.
grant execute on function public.pipeline_rollup() to authenticated;
grant execute on function public.pipeline_rollup() to service_role;
