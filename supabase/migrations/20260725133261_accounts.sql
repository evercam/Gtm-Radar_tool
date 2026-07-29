-- ============================================================================
-- 20260725133261_accounts
-- ----------------------------------------------------------------------------
-- Account layer on top of the one project table. Accounts are keyed by
-- account_key (Claude's normalized company identity, also on canonical_projects).
--
--   account_enrichment  one row per account — what Claude finds about the COMPANY
--                       (related entities, related projects, key-account score).
--   accounts_view       aggregates projects by account_key and joins the
--                       enrichment — the queryable "accounts" surface.
--
-- The single ingestion table (canonical_projects) is unchanged; this is a thin
-- derived/enrichment layer.
-- ============================================================================

create table if not exists public.account_enrichment (
  account_key text primary key,
  account_name text,
  account_role text,                 -- owner / developer / general_contractor / operator / architect
  parent_account text,
  related_entities jsonb default '[]'::jsonb,   -- [{ name, role, relationship }]
  related_projects jsonb default '[]'::jsonb,   -- [{ name, location, stage, est_value }]
  portfolio_project_count integer,
  portfolio_value_estimate numeric(15,2),
  revenue_band text,
  employee_count integer,
  expansion_signal text,
  tech_stack jsonb default '[]'::jsonb,
  -- key-account verdict (score computed by the app rubric; see lib/keyaccount.ts)
  key_account boolean default false,
  key_account_score integer,
  key_account_reasons jsonb default '[]'::jsonb,
  -- provenance / audit, same model as canonical_projects
  field_provenance jsonb not null default '{}'::jsonb,
  enrichment_jobs jsonb default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_accounts_key_account on public.account_enrichment (key_account, key_account_score desc);

drop trigger if exists trg_account_enrichment_updated_at on public.account_enrichment;
create trigger trg_account_enrichment_updated_at
  before update on public.account_enrichment
  for each row execute function public.set_updated_at();

-- Aggregated accounts surface: portfolio rollup per account_key + enrichment.
-- drop-then-create (not "create or replace") so column order can change safely.
drop view if exists public.accounts_view;
create view public.accounts_view as
select
  p.account_key,
  coalesce(e.account_name, max(p.company_name_raw))          as account_name,
  e.account_role,
  count(*)                                                    as project_count,
  -- portfolio size: the owner's asset count from enrichment (GEOT etc.), else
  -- the number of ingested project rows for this account.
  coalesce(e.portfolio_project_count, count(*)::int)          as portfolio_project_count,
  count(*) filter (where p.contact_status = 'has_contact')    as with_contact,
  coalesce(sum(p.estimated_value), e.portfolio_value_estimate) as total_value,
  max(p.estimated_value)                                      as largest_project_value,
  max(p.capacity_mw)                                          as capacity_mw,
  array_agg(distinct p.bu)                                    as bus,
  array_agg(distinct p.vertical)                              as verticals,
  min(p.announced_date)                                       as earliest_announced,
  max(p.announced_date)                                       as latest_announced,
  coalesce(e.key_account, false)                              as key_account,
  e.key_account_score,
  e.key_account_reasons,
  e.related_projects,
  e.related_entities,
  e.expansion_signal
from public.canonical_projects p
left join public.account_enrichment e on e.account_key = p.account_key
where p.account_key is not null
group by p.account_key, e.account_name, e.account_role, e.key_account,
         e.key_account_score, e.key_account_reasons, e.related_projects,
         e.related_entities, e.expansion_signal, e.portfolio_project_count,
         e.portfolio_value_estimate;
