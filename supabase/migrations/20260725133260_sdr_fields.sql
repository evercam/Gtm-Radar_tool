-- ============================================================================
-- 20260725133260_sdr_fields
-- ----------------------------------------------------------------------------
-- SDR-facing intelligence Claude generates per record: should I call, when,
-- and what do I say. Populated by enrichment and tagged 'claude' in
-- field_provenance. All nullable — a record is valid without them.
-- ============================================================================

alter table public.canonical_projects
  add column if not exists icp_fit_score integer,          -- 0..100 fit to Evercam ICP
  add column if not exists icp_fit_reason text,
  add column if not exists evercam_timing text
    check (evercam_timing in ('reach_now', 'watch', 'too_early', 'too_late')),
  add column if not exists trigger_event text,             -- the event making now the moment
  add column if not exists opening_hook text,              -- personalized first line
  add column if not exists value_angle text
    check (value_angle in ('confidence', 'evidence', 'capacity')),
  add column if not exists pain_point text,
  add column if not exists account_key text;               -- Claude's normalized company identity

create index if not exists idx_projects_icp_fit     on public.canonical_projects (icp_fit_score desc);
create index if not exists idx_projects_timing      on public.canonical_projects (evercam_timing);
create index if not exists idx_projects_account_key on public.canonical_projects (account_key);
