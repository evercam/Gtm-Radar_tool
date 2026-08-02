-- Apollo reveal cache.
--
-- Revealing an address costs one Apollo credit and the answer does not change
-- from one record to the next. It was being paid for again every time.
--
-- The waste is structural rather than occasional: now that subsidiaries resolve
-- to their parent, four Cleveland-Cliffs mining records each revealed the same
-- three people — twelve credits for three addresses. It scales with how many
-- projects a company has, and for portfolio-heavy sources like GEM that is the
-- normal case.
--
-- Keyed on Apollo's own person id, which is what `people/match` matches on, so
-- a hit is exact rather than a name guess.

create table if not exists apollo_reveal_cache (
  apollo_person_id text primary key,
  -- Null is a real, useful answer: Apollo has no address for this person. Not
  -- caching it means paying the credit again on every record that meets them.
  email text,
  full_name text,
  phone text,
  linkedin_url text,
  -- Which account the reveal was made against, for auditing a surprising hit.
  domain text,
  revealed_at timestamptz not null default now()
);

-- People move and addresses go stale, so entries are refreshed by age rather
-- than kept forever. The reader decides the TTL; this index makes the sweep
-- and the freshness check cheap.
create index if not exists apollo_reveal_cache_revealed_at_idx
  on apollo_reveal_cache (revealed_at desc);

comment on table apollo_reveal_cache is
  'Apollo people/match results keyed on person id, so one credit is spent per person rather than per record that mentions them.';

-- Service-role only. This holds personal contact data and nothing in the
-- browser has any reason to read it directly.
alter table apollo_reveal_cache enable row level security;
