-- What the CRM already knows about the company on a lead.
--
-- Zoho carries a hand-maintained Account_Type on every account, and two of its
-- values are worth more than anything this pipeline computes: `Forget it / Junk /
-- Avoid` is a do-not-call list somebody curated by hand, and `Lapsed` is a former
-- customer — a warm re-entry rather than a cold call. Neither existed anywhere in
-- the radar, so a rep could spend a slot on a company the business had already
-- decided to stop chasing.
--
-- FLAG ONLY, DELIBERATELY
--
-- Nothing here feeds scoring, routing or assignment. The matching was measured
-- before it was built: of the fifty most common companies in the workable book,
-- nine matched a CRM account cleanly and four matched something wrong or
-- unresolvable. A one-in-three error rate is fine for a badge a human reads and
-- nowhere near good enough to move a lead out of somebody's queue.
--
-- Additive and nullable throughout. A record with no verdict has simply not been
-- matched, which is the truth about all 111,802 of them until the importer runs.

alter table public.canonical_projects
  -- Zoho's account id, so a human can open the record rather than search for it.
  add column if not exists crm_account_id text,
  add column if not exists crm_account_name text,
  -- Zoho's Account_Type verbatim. Stored unmapped on purpose: the CRM owns this
  -- vocabulary and adds to it, and a value this table has never seen should
  -- arrive intact rather than be flattened into a guess.
  add column if not exists crm_account_type text,
  -- avoid | customer | lapsed | partner | known — the type reduced to what a rep
  -- should DO about it. See crmSignal() in lib/crm/accountMatch.ts.
  add column if not exists crm_signal text,
  -- domain | exact_name. A name match is weaker evidence than a shared domain and
  -- the difference has to survive into the UI, because only a fifth of CRM
  -- accounts carry a website at all.
  add column if not exists crm_match_basis text,
  add column if not exists crm_match_confidence text,
  add column if not exists crm_matched_at timestamptz;

-- Finding the leads somebody already decided not to chase. Partial, so it indexes
-- the exception rather than the whole table — `avoid` is expected to be a few
-- hundred rows against 111,802.
create index if not exists canonical_projects_crm_signal_idx
  on public.canonical_projects (crm_signal)
  where crm_signal is not null;
