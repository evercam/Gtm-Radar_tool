-- ============================================================================
-- 20260818160000_dashboard_rollup
-- ----------------------------------------------------------------------------
-- Make the dashboard render. It currently does not.
--
-- The page blocks on a Promise.all of five reads (app/page.tsx:134) and waits for
-- the slowest. Measured today against 109,552 rows:
--
--   getPipelineRollup      74.6 s   <-- walks the whole table
--   getBuRollup            73.7 s   <-- walks the whole table
--   getTopPriorityLeads     0.4 s
--   getDispositionRollup    1.1 s   <-- already an RPC with indexes
--   hasPriorityColumns      0.7 s
--
-- So the shell cannot paint for ~75 seconds and the page reads as permanently
-- loading. getDispositionRollup at 1.1 s is the same table and the same shape of
-- question, already fixed by 20260811160000 — this applies that fix to the two
-- that were left walking.
--
-- (getKpiSummary is 42 s and is NOT part of this. It is already behind a Suspense
-- boundary, so it streams in late rather than blocking the shell, and page.tsx
-- says so at line 216. Worth fixing next; it is not why nothing renders.)
--
-- SUPERSEDES 20260818140000_pipeline_rollup_index.sql, which was never applied.
-- That migration added a 7-column index for pipeline_rollup alone. Adding a second
-- index here for the dashboard's columns would mean two indexes to maintain on
-- every upsert, on a table whose nightly ingest is already timing out on writes.
-- One wider index covers both aggregates instead: ~20 MB and one write cost,
-- rather than ~23 MB and two. The narrow one is dropped if present.
-- ============================================================================

/*
  One index, both rollups, chosen so each aggregate can run as an INDEX ONLY SCAN.

  canonical_projects is 134 columns and roughly 4.7 KB a row — about 492 MB. A
  GROUP BY without a covering index is a sequential scan of all of it, which cannot
  finish inside the 8-second statement timeout: that is exactly how pipeline_rollup
  failed on its first outing (57014, measured at 8.8 s).

  Ten columns, being the union of what the two functions read. Order is not
  significant for coverage — an index-only scan needs every referenced column
  present, not in any particular position — so it leads with the dashboard's
  grouping keys, which is the hotter path.
*/
create index if not exists idx_projects_rollup_wide
  on canonical_projects (
    bu,
    vertical,
    contact_status,
    current_phase,
    priority_band,
    icp_code,
    contact_email,
    contact_phone,
    assignee_id,
    apollo_exported_at
  );

-- Superseded by the wide index above. Dropped rather than left, because a second
-- index on this table is paid for on every upsert and bought nothing once the
-- first one covers its columns.
drop index if exists idx_projects_rollup;

/*
  The dashboard's two rollups, as one aggregate.

  Both questions are answered from the same grouping, so they are one function
  rather than two: getPipelineRollup wants (bu, vertical, contact_status) and
  getBuRollup wants bu with reachable/assigned/exported/waiting. The caller sums
  whichever axis it needs.

  `reachable` and `waiting` are derived HERE rather than returned as the underlying
  contact columns, so the group key stays small — grouping by contact_email would
  return one row per lead and defeat the point entirely. `waiting` is not a column
  because it is `reachable and not assigned`, which the caller can compute without
  another grouping level.

  STABLE and security invoker for the same reasons as disposition_rollup: a pure
  aggregate over a table the caller can already read, so there is nothing to
  escalate, and definer would hand out a way to count rows RLS might hide.

  statement_timeout is raised as a backstop, not a fix. If the visibility map goes
  stale after a bulk load and the index-only scan degrades to heap fetches, a slow
  correct answer beats a failure that makes the page fall back to something slower.
*/
create or replace function public.dashboard_rollup()
returns table (
  bu text,
  vertical text,
  contact_status text,
  reachable boolean,
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
    bu,
    vertical,
    contact_status,
    (contact_email is not null or contact_phone is not null) as reachable,
    assignee_id is not null as assigned,
    apollo_exported_at is not null as exported,
    count(*) as n
  from canonical_projects
  group by 1, 2, 3, 4, 5, 6;
$$;

grant execute on function public.dashboard_rollup() to authenticated;
grant execute on function public.dashboard_rollup() to service_role;

/*
  Recreated only to attach the raised timeout, since 20260818140000 — which did
  that — is superseded and may never be applied. The body is unchanged from
  20260818120000.
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
