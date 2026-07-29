-- ============================================================================
-- 20260728180000_apollo_link_and_linkedin
-- ----------------------------------------------------------------------------
-- Four columns the export needs, and one the enrichment already finds and
-- throws away.
--
-- WHY apollo_account_id EXISTS AT ALL. The export sends a company name and a
-- website and lets Apollo decide which account a contact belongs to. That is
-- safe right up until a company has more than one account, and this workspace
-- has NINE "Balfour Beatty" accounts — five of them sharing balfourbeatty.com:
--
--     Balfour Beatty                 balfourbeatty.com   United Kingdom
--     Balfour Beatty (US)            balfourbeatty.com   United Kingdom  ← wrong
--     Balfour Beatty (Dublin)        balfourbeatty.com   (blank)
--     Balfour Beatty Major Projects  balfourbeatty.com   (blank)
--     Balfour Beatty Kilpatrick      balfourbeatty.com   United Kingdom
--
-- Country does not disambiguate them: the US account is labelled United
-- Kingdom and two have no country at all. The distinction lives only in the
-- account NAME. So the only safe key is Apollo's own account id, resolved once
-- and stored — never a domain match at push time.
--
-- `apollo_account_name` is stored alongside it so a human can see which of the
-- nine was chosen without opening Apollo, and `crm_record_url` records where
-- that account syncs to, which is what makes a wrong match visible.
-- ============================================================================

alter table public.canonical_projects
  -- Apollo identity, resolved once rather than guessed at every push.
  add column if not exists apollo_account_id text,
  add column if not exists apollo_account_name text,
  add column if not exists crm_record_url text,

  -- The contact's public profile. Enrichment has always found this — both
  -- Apollo and Claude return it — and then dropped it on the floor because
  -- there was nowhere to put it. It is the single most useful field for a BDR
  -- checking whether a contact is still in the role we think they are.
  add column if not exists contact_linkedin_url text,

  -- Opt-out state, read back from Apollo. Handing a BDR someone who has
  -- unsubscribed or opted out of calls is a compliance problem, not a data
  -- quality one, so it is a first-class column and not buried in raw_data.
  add column if not exists do_not_contact boolean not null default false,
  add column if not exists do_not_contact_reason text;

comment on column public.canonical_projects.apollo_account_id is
  'Apollo account this record belongs to. Resolved once; the export never matches on domain, because several accounts can share one.';
comment on column public.canonical_projects.apollo_account_name is
  'The chosen account''s name, so an ambiguous match is visible without opening Apollo.';
comment on column public.canonical_projects.crm_record_url is
  'Where the Apollo account syncs to in the CRM — how a wrong match is spotted.';
comment on column public.canonical_projects.contact_linkedin_url is
  'The primary contact''s public profile. Additional contacts carry their own in additional_contacts.';
comment on column public.canonical_projects.do_not_contact is
  'Unsubscribed or opted out of calls in Apollo. Never hand these to a BDR.';

create index if not exists idx_projects_apollo_account
  on public.canonical_projects (apollo_account_id)
  where apollo_account_id is not null;

-- Excluding opted-out records is a filter on every outbound query, so it is
-- worth an index on the small side of the split.
create index if not exists idx_projects_dnc
  on public.canonical_projects (do_not_contact)
  where do_not_contact = true;
