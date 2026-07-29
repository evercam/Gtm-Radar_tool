-- ============================================================================
-- 20260726120000_source_credentials
-- ----------------------------------------------------------------------------
-- Per-source API credentials, saved from /settings.
--
-- This table has been referenced by the application since the beginning
-- (src/lib/actions/credentials.ts, src/lib/adapters/credentials.ts,
-- credentialStatus.ts, settingsData.ts and both ingest routes) but was never
-- defined in any migration — saving a key silently failed with a PostgREST
-- 404. This migration creates it.
--
-- Values land here in plaintext for one release only; the AES-256-GCM
-- migration that follows re-types the secret columns and moves existing rows
-- behind envelope encryption. Nothing outside the service role may read it.
-- ============================================================================

create table if not exists public.source_credentials (
  source_key text primary key,

  -- secrets — service-role only, never exposed to the browser
  api_key text,
  api_secret text,          -- Barbour ABI's password; unused by most sources

  -- non-secret connection detail
  username text,            -- only Barbour ABI's two-step login needs this
  base_url text,

  -- populated by the "Test connection" button
  is_configured boolean not null default false,
  last_tested_at timestamptz,
  last_test_result text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_source_credentials_updated_at on public.source_credentials;
create trigger trg_source_credentials_updated_at
  before update on public.source_credentials
  for each row execute function public.set_updated_at();

-- `is_configured` is derived, not hand-maintained: a row is configured once it
-- carries a key. Keeping this in the database means the flag can never drift
-- from reality regardless of which code path wrote the row.
create or replace function public.set_source_credential_configured()
returns trigger
language plpgsql
as $$
begin
  new.is_configured = (new.api_key is not null and length(trim(new.api_key)) > 0);
  return new;
end;
$$;

drop trigger if exists trg_source_credentials_configured on public.source_credentials;
create trigger trg_source_credentials_configured
  before insert or update on public.source_credentials
  for each row execute function public.set_source_credential_configured();

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
-- No policy is defined on purpose. RLS is enabled and nothing is granted, so
-- the anon and authenticated roles can never read this table under any query;
-- the service-role key bypasses RLS, and every legitimate reader
-- (adapters/credentials.ts, settingsData.ts) already uses it. A leaked
-- publishable key therefore exposes nothing here.
alter table public.source_credentials enable row level security;

revoke all on public.source_credentials from anon, authenticated;
