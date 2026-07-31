-- ============================================================================
-- 20260730120000_owner_group_key
-- ----------------------------------------------------------------------------
-- Groups leads by the company that owns the asset.
--
-- The problem: 16,332 of 16,515 project records have no `account_key`, because
-- that column is only ever written by Claude enrichment or the key-account
-- importers. Nothing groups an owner's portfolio until money has been spent
-- enriching it, which is backwards — the whole point of seeing a portfolio is
-- to decide whether to spend.
--
-- `owner_group_key` is the cheap, deterministic answer, derived at ingest from
-- what the source already publishes. It is NOT a replacement for `account_key`:
--
--   account_key      curated identity of an account record we hold, exact,
--                    refreshed by enrichment, sparse (183 rows today)
--   owner_group_key  best-effort grouping of leads by owner, set at ingest,
--                    never touched by enrichment, dense (92% of GEM)
--
-- Keeping them separate is the point. Enrichment rewrites `account_key` every
-- run, so a grouping stored there would be unstable; and a grouping good enough
-- to browse by is not good enough to call a curated account.
--
-- ----------------------------------------------------------------------------
-- The `E:` / `N:` prefix is load-bearing
-- ----------------------------------------------------------------------------
-- Values carry their own provenance:
--
--   E:E100000000980              a real owner identifier from the source
--                                (GEM Entity ID). Exact and stable.
--   N:duke-energy-carolinas      a slug of the owner's NAME. Best effort: two
--                                spellings of one company stay apart until an
--                                identifier turns up.
--
-- Without the prefix the two are indistinguishable, and a name slug could
-- collide with something that merely looks like an id. With it, a query can ask
-- for only the trustworthy groups (`like 'E:%'`), and the UI can be honest
-- about which kind of grouping a user is looking at.
--
-- `company_id` was the obvious home for this and is deliberately not used: it
-- is `uuid`, so it cannot hold `E100000000980` at all.
-- ============================================================================

alter table public.canonical_projects
  add column if not exists owner_group_key text;

comment on column public.canonical_projects.owner_group_key is
  'Owner grouping, set at ingest and never by enrichment. Prefixed with its provenance: "E:" = a source-published owner identifier (exact), "N:" = a slug of the owner name (best effort). Distinct from account_key, which is the curated account identity. See migration 20260730120000.';

-- Supports the two queries this exists for: every lead for one owner, and the
-- owner-portfolio rollup (group by owner, order by size). `priority_score desc`
-- is included so an owner's leads come back worst-first-to-best without a sort,
-- which is how both the drawer and the rollup read them.
create index if not exists idx_projects_owner_group
  on public.canonical_projects (owner_group_key, priority_score desc nulls last)
  where owner_group_key is not null;

-- Counting distinct owners across a filtered set is the rollup's hot path and
-- does not benefit from the composite above.
create index if not exists idx_projects_owner_group_plain
  on public.canonical_projects (owner_group_key)
  where owner_group_key is not null;
