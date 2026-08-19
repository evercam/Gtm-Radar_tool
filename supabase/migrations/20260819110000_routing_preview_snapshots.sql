-- ============================================================================
-- 20260819110000_routing_preview_snapshots
-- ----------------------------------------------------------------------------
-- Stop scoring 111,353 records on every visit to /control/routing.
--
-- Measured today:
--
--   getRoutingPreview                        41.5 s   111,353 records
--   reading ONLY the id column of that table  31.3 s  (pure database time)
--
-- The second line is the finding. The preview is not slow because scoring is
-- expensive — it is slow because the rows have to cross the wire at all. Fetching
-- one column of 111k rows already costs 31 s, so ~31 s of the 41.5 s is transfer
-- and ~10 s is the engine. The columns are already narrowed to twenty (not
-- select *), and the read already runs six slices concurrently by keyset; both of
-- those helped it stop timing out and neither changes the floor.
--
-- WHY NOT A SQL AGGREGATE, unlike setup_state_rollup in the migration before this
-- one. getRoutingPreview folds every row through `toScoredRecord` and `routeRecord`
-- — the actual scoring and routing engines. This screen's entire purpose is to
-- preview what the real run will do, so it has to use the code the real run uses.
-- Re-expressing those in SQL would create two definitions of what a lane is,
-- obliged to agree forever, and the failure mode of their disagreeing is a preview
-- that confidently describes a re-route that then does something else.
--
-- So the snapshot pattern from kpi_snapshots, for the same reason: the thing that
-- fills it IS the existing TypeScript, so there is no second implementation to
-- drift.
--
-- THE COST IS FRESHNESS, and here it needs more care than the KPI cards did. This
-- screen is what somebody checks BEFORE re-routing the whole book, and it is also
-- where they edit the rules — so a cached preview of the PREVIOUS ruleset would be
-- actively misleading in the one moment the screen matters. That is what the
-- fingerprint key below is for: a snapshot is only ever served for the exact rules
-- and scoring it was computed from, so editing a rule is a cache miss by
-- construction rather than by somebody remembering to invalidate.
-- ============================================================================

create table if not exists routing_preview_snapshots (
  /*
    A hash of the rules plus the scoring configuration IS the key.

    Not a single row with a validity flag, and not the policy id: the preview is a
    pure function of (rules, scoring), so anything that changes either produces a
    different key and therefore a miss. There is no invalidation step to forget.

    The practical consequence worth knowing: editing rules leaves the old row behind.
    That is deliberate — flipping a rule back restores a warm preview — and the
    refresh prunes anything that has not been read for a while, so the table stays
    small rather than growing one row per keystroke.
  */
  fingerprint text primary key,
  /*
    The whole RoutingPreview, as lib/queries.ts already returns it.

    jsonb rather than columns for the same reason as kpi_snapshots: the shape is
    nested (byLane, byRule, byBand, facets) and will change as lanes and facets are
    added. Nothing queries inside it; it is read whole by the function that wrote it.
  */
  preview jsonb not null,
  computed_at timestamptz not null default now(),
  /*
    Last time this row was served. Drives pruning, and answers "is this fingerprint
    still in use or a fossil of an abandoned edit".
  */
  last_read_at timestamptz not null default now(),
  /*
    How long the build took. Kept for the same reason as kpi_snapshots: it is the
    number that tells you whether this table still earns its place. If a refresh ever
    returns in a second, the underlying read got fixed and this can go.
  */
  duration_ms integer
);

/*
  Prune by last read, not by age.

  A snapshot of the CURRENT ruleset should survive indefinitely — it is the one being
  served — so expiring on computed_at would throw away the only row that matters and
  make every visit after the cutoff pay 41 s. Expiring on last_read_at removes the
  fossils of abandoned rule edits instead, which is what actually accumulates.
*/
create index if not exists routing_preview_snapshots_last_read_idx
  on routing_preview_snapshots (last_read_at);

alter table routing_preview_snapshots enable row level security;

/*
  Readable by any signed-in user, writable only through the service role.

  Safe to expose because this holds no row anybody could be denied — only lane, band
  and rule COUNTS over the whole book, which the page already shows to anyone holding
  routing.edit. Writes are service-role only: a session that could write here could
  put any numbers it liked on the screen that gates a bulk re-route.
*/
drop policy if exists routing_preview_snapshots_read on routing_preview_snapshots;
create policy routing_preview_snapshots_read on routing_preview_snapshots
  for select to authenticated using (true);
