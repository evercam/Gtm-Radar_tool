-- Why the contact on a record is the one a seller should call.
--
-- The choice used to be made and forgotten: ranking happened in memory and only
-- the winner's name reached the row. So "why this person?" had no answer, and the
-- specific failure that motivated this work — a Project Director who left in
-- March outranking a current site manager in the right state — was invisible in
-- the data and could only be found by re-running the enrichment by hand.
--
-- Additive only. Every column is nullable and nothing reads them as required, so
-- the ~30k records enriched before this migration stay valid and simply have no
-- verdict, which is the truth about them.

alter table public.canonical_projects
  -- Where the contact is, as Apollo reported it on the reveal we already paid for.
  add column if not exists contact_state text,
  -- same_state | nearby | distant | unknown.
  -- `unknown` is a distinct answer from `distant`, never a synonym for it: 41% of
  -- reachable leads carry no state, and folding those into "far" would demote two
  -- fifths of the book for a missing field rather than for anything about the
  -- contact.
  add column if not exists contact_geo_match text,
  -- current | left | unknown. `left` never reaches a record as the primary
  -- contact; it is recorded on the ones that were dropped.
  add column if not exists contact_employment_status text,
  -- The strongest job-change signal, in words. Not a boolean, because "started at
  -- Duke Energy last month" and "changed title within NRG" need different actions.
  add column if not exists contact_job_change_signal text,
  add column if not exists contact_match_score integer,
  add column if not exists contact_match_reasons text[],
  -- high | medium | low. A company switchboard fallback is always low.
  add column if not exists contact_match_confidence text;

-- Finding the leads whose contact is a switchboard rather than a person, which is
-- the population to re-enrich first when Apollo's coverage improves. Partial, so
-- it indexes the exception rather than the 30k rows that are not it.
create index if not exists canonical_projects_low_match_idx
  on public.canonical_projects (contact_match_confidence)
  where contact_match_confidence = 'low';
