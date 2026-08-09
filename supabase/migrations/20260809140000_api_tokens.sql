-- Bearer tokens for the in-app MCP endpoint.
--
-- The stdio MCP server runs on the caller's own machine with their .env.local,
-- so it needs no credential of its own. An HTTP endpoint does: it is reachable
-- by anything that can resolve the host, so it must prove who is asking before
-- it answers.
--
-- A token carries a ROLE, not a set of permissions. That is deliberate — it
-- means a token is governed by the same role definitions as a person, so
-- narrowing a role narrows every token issued against it, and there is one place
-- to look when asking what something may read.

create table if not exists api_tokens (
  id uuid primary key default gen_random_uuid(),
  /* Shown in the UI so a token can be recognised without revealing it. */
  name text not null,
  /*
    SHA-256 of the token, never the token.

    The plaintext is displayed exactly once, at creation, and is not recoverable
    afterwards — a leaked database gives an attacker hashes, not working
    credentials. There is no "reveal" for the same reason.
  */
  token_hash text not null unique,
  /* The first characters, for identification in a list. Not enough to use. */
  token_prefix text not null,
  role text not null references app_roles(name) on update cascade,
  created_by uuid references user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  /* Soft revocation: the row stays so the audit trail survives the revoke. */
  revoked_at timestamptz
);

create index if not exists idx_api_tokens_hash on api_tokens(token_hash) where revoked_at is null;

alter table api_tokens enable row level security;

/*
  No policy at all — not even read.

  Every access goes through the service role behind a settings.manage check in
  the route. A table holding credentials should not be readable by the sessions
  it authenticates, and listing hashes buys an attacker offline guesses.
*/
