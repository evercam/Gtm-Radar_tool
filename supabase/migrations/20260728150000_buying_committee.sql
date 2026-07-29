-- ============================================================================
-- 20260728150000_buying_committee
-- ----------------------------------------------------------------------------
-- Keeps the whole buying committee, not just one name.
--
-- Enrichment already asked Apollo for several contacts per account and then
-- wrote exactly one of them to contact_name/email/phone. The rest were
-- discarded — paid for, then thrown away — which is the opposite of what the
-- LDR guide asks for: an enterprise account needs two economic buyers, two
-- operational, two champions and two users before it is worth handing to a
-- BDR.
--
--   additional_contacts  everyone found beyond the primary, with their role
--   contact_role         which buying role the primary contact occupies
--   committee_coverage   what the account has vs what the standard requires
--
-- Stored as jsonb rather than a child table on purpose: these are a snapshot
-- of one enrichment pass, always read with the record, and never queried
-- independently of it.
-- ============================================================================

alter table public.canonical_projects
  add column if not exists additional_contacts jsonb not null default '[]'::jsonb,
  add column if not exists contact_role text,
  add column if not exists committee_coverage jsonb;

comment on column public.canonical_projects.additional_contacts is
  'Contacts found beyond the primary: [{name,title,email,phone,linkedin_url,role,source}]. The primary stays in contact_*.';
comment on column public.canonical_projects.contact_role is
  'Buying role of the primary contact: economic | operational | champion | user | technical.';
comment on column public.canonical_projects.committee_coverage is
  'Coverage against the list-quality standard: {size, found:{role:n}, missing:[{role,need}], complete}.';

-- Finding the accounts that are one economic buyer short is the question this
-- data exists to answer, so it is worth an index.
create index if not exists idx_projects_contact_role
  on public.canonical_projects (contact_role)
  where contact_role is not null;
