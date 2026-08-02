-- When an account was last researched, and what was found.
--
-- Account research is a web-search call about a COMPANY: its parent, portfolio,
-- revenue band, expansion signals. The answer does not vary by which of that
-- company's projects prompted it — so NextEra Energy, which holds 270 records,
-- was implying 270 identical searches.
--
-- `account_enrichment` already stores the findings (parent_account,
-- related_projects, portfolio_value_estimate, revenue_band, expansion_signal,
-- tech_stack). What it could not express is "this has been researched, and
-- when", because `updated_at` moves every time any record of that account is
-- enriched — so it says nothing about the research specifically.
--
-- Without these two columns the split still works; every account is simply
-- treated as never researched and pays for the call again. With them, the
-- second and subsequent projects at a company are free.

alter table account_enrichment
  add column if not exists researched_at timestamptz;

-- The prose a per-record brief is written from. Kept alongside the structured
-- fields because the model writing the brief needs the narrative, not just the
-- numbers, and re-deriving it from the columns loses what mattered.
alter table account_enrichment
  add column if not exists research_summary text;

-- Finding the accounts due for research is the query the brief job runs every
-- time, so it should not scan.
create index if not exists account_enrichment_researched_at_idx
  on account_enrichment (researched_at nulls first);

comment on column account_enrichment.researched_at is
  'When Claude last researched this company. Distinct from updated_at, which moves whenever any of its records is enriched.';
