-- ============================================================================
-- 20260728160000_per_source_enrichment
-- ----------------------------------------------------------------------------
-- Per-source control over what enrichment is allowed to spend.
--
-- The enrichment policy is global: one set of engine toggles and caps for
-- every record in the database. But sources are not alike. GEM records are
-- energy asset owners that Apollo's B2B index barely knows, so Apollo calls
-- against them mostly return nothing while Claude's web search does the work.
-- News records rarely have an account worth resolving at all. A single global
-- setting has to be tuned for the worst case, which means over-spending on
-- some feeds and under-serving others.
--
-- These columns are OVERRIDES, not replacements: null means "use the global
-- policy". So a source that nobody has touched behaves exactly as it does
-- today, and turning one engine off for one feed does not require restating
-- everything else.
-- ============================================================================

alter table public.source_config
  add column if not exists enrich_claude boolean,
  add column if not exists enrich_apollo boolean,
  add column if not exists enrich_fill_committee boolean,
  add column if not exists max_apollo_calls_per_record integer,
  add column if not exists max_claude_calls_per_record integer;

comment on column public.source_config.enrich_claude is
  'Override the global Claude engine toggle for records from this source. Null = use the policy.';
comment on column public.source_config.enrich_apollo is
  'Override the global Apollo engine toggle for records from this source. Null = use the policy.';
comment on column public.source_config.enrich_fill_committee is
  'Override committee gap-filling for this source. Null = use the policy.';
comment on column public.source_config.max_apollo_calls_per_record is
  'Hard ceiling on Apollo calls while enriching one record from this source. Null = uncapped beyond the policy.';
comment on column public.source_config.max_claude_calls_per_record is
  'Hard ceiling on Claude calls while enriching one record from this source. Null = uncapped beyond the policy.';
