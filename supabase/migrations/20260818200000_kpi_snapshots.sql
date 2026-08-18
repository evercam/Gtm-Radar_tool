-- ============================================================================
-- 20260818200000_kpi_snapshots
-- ----------------------------------------------------------------------------
-- Stop recomputing the same three numbers on every dashboard load.
--
-- getKpiSummary is now the slowest thing on the dashboard by a wide margin. After
-- 2f9735d parallelised its read it is 35-46 s for the default 30-day window, and
-- the KPI row sits at the TOP of the page — so it is what somebody watches a
-- skeleton for.
--
-- Measured today:
--
--   team,  7 days    6.9 s   21,426 rows
--   team, 30 days   45.9 s  109,552 rows
--   team, 90 days   19.5 s  109,552 rows
--   ONE SELLER, 30  1.3 s        30 rows
--
-- That last row is the point. A seller's own numbers are already fast, because
-- filtering on owner_user_id cuts 109,552 rows to 30. This is not a general
-- performance problem — it is THREE VALUES: the team view at each of the three
-- windows the dashboard offers. So they get computed once and stored.
--
-- WHY A SNAPSHOT AND NOT A SQL AGGREGATE, unlike the three rollups. The code that
-- produces this summary derives a funnel position, a furthest-stage-reached fan-out,
-- an SLA breach against wall-clock now, contact-latency percentiles and three
-- breakdowns — several hundred lines whose failure mode is a plausible wrong number
-- rather than an error. lib/kpi.ts already carries the scar of exactly that: see the
-- ORDER BY note, where every KPI on the dashboard was silently a random 72% sample.
-- Re-expressing that in SQL would mean two definitions of the funnel, in two
-- languages, obliged to agree forever.
--
-- A snapshot avoids the duplication completely, because the thing that fills it IS
-- the existing TypeScript. There is no second implementation to drift.
--
-- THE COST IS FRESHNESS, and it is a real cost. These numbers become as recent as
-- the last refresh rather than live. Two mitigations, and the second matters more:
-- the cron refreshes them on every run, and the summary carries `computed_at` so the
-- cards can say "as of 14:20" instead of implying live data. Serving stale figures as
-- though they were current would be a worse bug than the slowness it fixed.
-- ============================================================================

create table if not exists kpi_snapshots (
  /*
    The window in days IS the key. Team view only — one row per window the dashboard
    offers, so three rows in practice.

    Per-seller views are deliberately absent: at 1.3 s they do not need this, and
    keying by owner as well would turn three rows into three per person, each
    needing its own refresh, to cache something already fast.
  */
  window_days integer primary key,
  /*
    The whole summary, as the shape lib/kpi.ts already returns.

    jsonb rather than columns because that shape is nested and is going to change —
    funnel stages, three breakdowns, percentiles — and a column per figure would
    mean a migration every time somebody adds a KPI. Nothing queries inside this; it
    is read whole by the one function that wrote it.
  */
  summary jsonb not null,
  computed_at timestamptz not null default now(),
  /*
    How long it took to build. Kept because it is the number that tells you whether
    this table is still earning its place: if a refresh ever comes back in a second,
    the underlying read got fixed and the snapshot could go.
  */
  duration_ms integer
);

alter table kpi_snapshots enable row level security;

/*
  Readable by any signed-in user, writable only through the service role.

  The read policy is safe because this is the TEAM aggregate — it holds no row
  anybody could be denied, only counts over the whole book, and the dashboard already
  shows those to anyone holding kpi.view.team. Writes are service-role only because
  the only legitimate writer is the refresh, and a session that could write here could
  put any numbers it liked on everybody's dashboard.
*/
drop policy if exists kpi_snapshots_read on kpi_snapshots;
create policy kpi_snapshots_read on kpi_snapshots
  for select to authenticated using (true);
