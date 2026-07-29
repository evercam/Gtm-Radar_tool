-- ============================================================================
-- 20260726140000_encrypted_secrets
-- ----------------------------------------------------------------------------
-- Moves every API key out of environment variables and into the database,
-- encrypted at rest with AES-256-GCM (see src/lib/crypto/secrets.ts).
--
--   * app_secrets       — the platform-wide keys (Anthropic, Apollo, Hunter…)
--                         that previously lived only in .env.local
--   * key_version       — which encryption key produced each ciphertext, so a
--                         rotation can re-encrypt rows in the background
--
-- Ciphertexts are self-describing (`v1:<keyId>:<iv>:<tag>:<ct>`), so no key
-- material is stored here and a row can be read back by any process holding
-- the matching master key.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Platform-wide secrets
-- ----------------------------------------------------------------------------
create table if not exists public.app_secrets (
  key text primary key,          -- logical name, e.g. 'anthropic_api_key'

  value_encrypted text,          -- AES-256-GCM envelope, never plaintext
  key_version text,              -- id of the encryption key used

  -- Non-secret display metadata so Settings can show state without decrypting.
  last4 text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

drop trigger if exists trg_app_secrets_updated_at on public.app_secrets;
create trigger trg_app_secrets_updated_at
  before update on public.app_secrets
  for each row execute function public.set_updated_at();

-- Nothing but the service role may touch this table. RLS is enabled with no
-- policy granted, so anon and authenticated cannot read a row under any query.
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Per-source credentials — add encryption metadata
-- ----------------------------------------------------------------------------
-- The existing api_key / api_secret columns are reused to hold the envelope
-- rather than plaintext. `key_version` records which key wrote them so a
-- rotation knows what still needs re-encrypting; `last4` lets Settings show a
-- masked hint without decrypting anything.
-- Guarded because `source_credentials` is created by 20260726120000. This file
-- does not depend on that one, so run them in either order and both work.
do $$
begin
  if to_regclass('public.source_credentials') is not null then
    alter table public.source_credentials
      add column if not exists key_version text,
      add column if not exists api_key_last4 text,
      add column if not exists api_secret_last4 text;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Migrating values already stored in plaintext
-- ----------------------------------------------------------------------------
-- Existing rows (written before this migration) hold raw keys. They are left
-- untouched here on purpose: encrypting them requires the master key, which
-- lives in the application, not in Postgres.
--
-- The app handles this transparently — `readSecret` detects a value that is
-- not in envelope format and returns it as-is, and the next save re-writes it
-- encrypted. To convert everything at once, open
-- /control/settings and use "Re-encrypt stored secrets".
