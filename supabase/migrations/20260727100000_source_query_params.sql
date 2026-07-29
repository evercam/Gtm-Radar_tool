-- ============================================================================
-- 20260727100000_source_query_params
-- ----------------------------------------------------------------------------
-- The saved query a scheduled ingest actually runs.
--
-- Until now Search and Seeding were separate: you could tune a query against a
-- source and see results, but those filters were discarded — the scheduled
-- ingest ran with defaults and no way to say "pull THIS". That made the search
-- panel a toy rather than the thing that configures ingestion.
--
-- `query_params` stores the filter payload the search panel produces, in
-- exactly the shape /api/ingest/[source] already accepts, so the same query
-- you previewed is the one the schedule runs.
-- ============================================================================

alter table public.source_config
  add column if not exists query_params jsonb not null default '{}'::jsonb,
  add column if not exists query_saved_at timestamptz,
  add column if not exists query_saved_by uuid;

comment on column public.source_config.query_params is
  'Filter payload for scheduled ingestion — same shape as the /api/ingest/[source] body. Saved from the Source Hub search panel.';
