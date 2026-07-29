-- ============================================================================
-- 20260725133259_provenance
-- ----------------------------------------------------------------------------
-- Field-level data provenance: know whether each value is original (from the
-- source) or was added by enrichment (Claude / Apollo), and exactly which
-- columns enrichment filled.
--
--   field_provenance  jsonb  { "<column>": "source" | "claude" | "apollo", ... }
--   enrichment_jobs   jsonb  (already present) — appended one entry per run:
--                            { at, engines, fields_added:[...], account, confidence }
--
-- Rule enforced by the app: enrichment only fills EMPTY columns, so a value
-- marked "source" is never overwritten — original data stays original.
--
-- Two company columns added so Claude's account resolution has somewhere to
-- land (previously there was no column for them).
-- ============================================================================

alter table public.canonical_projects
  add column if not exists company_website text,
  add column if not exists company_domain text,
  add column if not exists field_provenance jsonb not null default '{}'::jsonb;

create index if not exists idx_projects_provenance_gin
  on public.canonical_projects using gin (field_provenance);
