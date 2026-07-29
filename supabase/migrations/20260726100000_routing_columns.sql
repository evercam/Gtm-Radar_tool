-- ============================================================================
-- 20260726100000_routing_columns
-- ----------------------------------------------------------------------------
-- Materialized disposition on each record — written by the routing engine
-- ("Re-route all" / on ingest). Lets you filter and count records by lane.
-- ============================================================================

alter table public.canonical_projects
  add column if not exists route text,            -- sales | marketing | partner | none
  add column if not exists stage text,            -- act_now | qualify | nurture | hold | disqualify
  add column if not exists assigned_team text,
  add column if not exists routing_reason text,   -- which rule fired
  add column if not exists routed_at timestamptz;

create index if not exists idx_projects_route on public.canonical_projects (route, stage);
