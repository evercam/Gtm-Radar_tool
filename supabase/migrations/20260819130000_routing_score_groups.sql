-- ============================================================================
-- 20260819130000_routing_score_groups
-- ----------------------------------------------------------------------------
-- Cache the expensive half of the routing preview, not the whole thing.
--
-- 20260819110000 cached the finished preview under a hash of (rules, scoringConfig)
-- together. That made a repeat visit instant — 41.5 s to 227 ms — and left one case
-- untouched: editing a rule changes the key, so the next visitor pays the full 42 s
-- rebuild. On the screen whose whole purpose is editing rules.
--
-- The seam was in the wrong place. The preview is two stages with different inputs:
--
--   read 111,353 rows and SCORE each   depends on the scoring config    ~42 s
--   apply the RULES to the result      depends on the rules             ~26 ms
--
-- Keying both together threw away the 42 s of work on every rule edit even though
-- the rules cannot affect it.
--
-- WHAT MAKES THE SPLIT EXACT rather than an approximation. Rules match on a bounded
-- input space — RoutingMatch is six discrete fields, two booleans and three 0..100
-- numbers — so many records share a routing decision. Grouping by every field
-- routeRecord can read means all records in a group necessarily route identically.
-- Measured on the live table:
--
--   111,353 records  ->  5,958 distinct groups   (18.7x collapse)
--   routing those groups: 26 ms
--   output verified field-by-field identical to the per-row implementation
--
-- (Estimated at 3,937 from the STORED priority_score before building it; the real
-- figure after rescoring is 5,958. Same order, and the difference is why the
-- estimate was checked before anything was built on it.)
--
-- So a rule edit now costs one row read plus 26 ms. Only a SCORING-policy change
-- pays the scan, and that is edited elsewhere.
--
-- REPLACES routing_preview_snapshots, which this migration drops. Its rows are
-- finished previews keyed the old way; there is nothing to migrate, because the new
-- table holds a different thing and the first read rebuilds it.
-- ============================================================================

/*
  Keyed on the SCORING configuration alone — that is the entire point.

  Not (rules, scoring): the groups are a pure function of the scoring config and the
  table contents, so putting rules in the key would reintroduce exactly the
  invalidation this migration exists to remove.
*/
create table if not exists routing_score_groups (
  scoring_fingerprint text primary key,
  /*
    The groups, as lib/queries.ts returns them: one entry per distinct routing input
    with its RoutableRecord, scored priority, band, and a count.

    ~6,000 entries, low single-digit MB as jsonb, which Postgres TOASTs out of line.
    jsonb rather than a row per group because nothing queries inside it — it is read
    whole, once, by the function that wrote it, and a table of six thousand rows per
    scoring config would need its own pagination to read back.
  */
  groups jsonb not null,
  /* The record count the groups sum to. Stored rather than derived so a caller can
     report the total without walking six thousand entries. */
  total integer not null,
  computed_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  duration_ms integer
);

/*
  Prune by last read, not by age — the current scoring config's groups are the ones
  being served and must survive indefinitely, so expiring on computed_at would
  discard the only row that matters and make the next visit pay 42 s.
*/
create index if not exists routing_score_groups_last_read_idx
  on routing_score_groups (last_read_at);

alter table routing_score_groups enable row level security;

/*
  Readable by any signed-in user, writable only through the service role.

  Worth a second look versus the table it replaces, because this one is less
  aggregated: it holds per-group field values (bu, vertical, country, key-account
  flag, priority) rather than finished counts. It still holds no row-level identifier
  — no id, ref, company, contact or account key — so a group is a description of a
  bucket, not of a record, and the facet values in it are already shown to anyone
  holding routing.edit by the rule builder. Writes stay service-role only: a session
  that could write here could put any numbers on the screen that gates a bulk
  re-route.
*/
drop policy if exists routing_score_groups_read on routing_score_groups;
create policy routing_score_groups_read on routing_score_groups
  for select to authenticated using (true);

/*
  The finished-preview cache this replaces.

  Dropped rather than left in place: it would keep being written by nothing and read
  by nothing, and a stale table whose name suggests it is the routing cache is how
  the next person debugging this loses an hour.
*/
drop table if exists routing_preview_snapshots;
