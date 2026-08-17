-- OAuth 2.1 for the HTTP MCP endpoint.
--
-- WHY THIS EXISTS, given api_tokens already works.
--
-- api_tokens answers "what may this credential read" and nothing else. That is
-- the right shape for a script, and the wrong shape for a person: the token has
-- to be typed into a client by hand, and a hosted client — claude.ai being the
-- one that prompted this — has nowhere to type it. Its connector UI speaks
-- OAuth or nothing.
--
-- So the missing piece is not a stronger credential, it is a credential a
-- browser can obtain on a person's behalf. Which brings the better property
-- with it: the token belongs to a USER, so it reads through that user's own
-- role. Two colleagues connecting the same workspace do not end up sharing one
-- token's permissions, and deactivating somebody's profile stops their
-- connector at the same moment it stops their browser.
--
-- Three tables, one per lifetime:
--   oauth_clients — a registered application. Lives until revoked.
--   oauth_authorization_codes — one attempt to sign in. Lives ~60 seconds.
--   oauth_tokens — an access or refresh token. Lives hours or weeks.
--
-- All three follow api_tokens on storage: the secret is never stored, only its
-- SHA-256. RLS is on with no policy at all, so every read goes through the
-- service role in a route that has already decided who is asking.

/*
  A client application, as registered by RFC 7591 dynamic client registration.

  Registration is open and unauthenticated, because that is the only way a
  hosted client that has never heard of this workspace can present itself. That
  is far less alarming than it first reads: registering yields a client_id and
  nothing else. It grants no access whatsoever. Access requires a signed-in
  Evercam user to reach the consent screen and approve that specific client, and
  the code then only comes back on a redirect_uri fixed at registration time.

  A registered client nobody approved is therefore an inert row. The rate limit
  below exists to stop those rows accumulating, not to protect data.
*/
create table if not exists oauth_clients (
  /* Public identifier, sent in the clear on every authorize and token call. */
  client_id text primary key,
  /*
    SHA-256 of the client secret, or null for a public client.

    Public is the normal case here and the one the MCP spec assumes: a client
    running in someone's browser or on Anthropic's servers cannot keep a secret
    from its own user, so pretending otherwise buys nothing. PKCE is what
    actually binds the code to the caller, and it is required either way — see
    the check on oauth_authorization_codes.
  */
  client_secret_hash text,
  client_name text not null,
  /*
    Exact URIs the authorization code may be returned to. Matched byte for byte,
    never by prefix or by host: prefix matching on a redirect URI is how
    authorization codes get delivered to the wrong place, and an open redirect
    anywhere on an allowed host becomes a code exfiltration path.
  */
  redirect_uris text[] not null check (cardinality(redirect_uris) > 0),
  grant_types text[] not null default array['authorization_code', 'refresh_token'],
  scope text not null default 'mcp:read',
  /* Reported by the client at registration; kept only so a row is identifiable. */
  software_id text,
  software_version text,
  /* Who, if anybody, has ever approved this client — for the audit trail. */
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  /* Soft revocation, so the audit trail survives it. Cascades to tokens. */
  revoked_at timestamptz
);

/*
  Registration rate limiting, by the hour it happened in.

  Unauthenticated writes need a ceiling or they are a way to fill a disk. Kept
  as a count rather than by IP: the useful limit here is on rows created, and IP
  is both spoofable and, behind a CDN, frequently shared by everyone.
*/
create index if not exists idx_oauth_clients_created on oauth_clients(created_at desc);

/*
  One authorization attempt.

  Deleted rather than kept after use — consumed_at exists so that a REPLAY is
  detectable within the row's short life, which is the attack that matters
  (a code intercepted in a redirect and redeemed twice). Anything older than a
  few minutes is cleaned up by the token endpoint as it goes.
*/
create table if not exists oauth_authorization_codes (
  code_hash text primary key,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  /* The person who approved it. The token inherits their role, not the client's. */
  user_id uuid not null references user_profiles(id) on delete cascade,
  /* Recorded so the token endpoint can require the same value back, per RFC 6749 §4.1.3. */
  redirect_uri text not null,
  /*
    PKCE, and NOT NULL on purpose.

    RFC 7636 is optional in OAuth 2.0 and mandatory in 2.1, and making the
    column required is the cheapest possible way to guarantee no code path can
    quietly mint a code without it. There is no plain method either — S256 only,
    enforced by the check — because `plain` sends the verifier over the same
    channel as the challenge and protects against nothing.
  */
  code_challenge text not null,
  code_challenge_method text not null default 'S256' check (code_challenge_method = 'S256'),
  scope text not null default 'mcp:read',
  /*
    RFC 8707 resource indicator — which API the token is for.

    The MCP spec requires clients to send it, and recording it is what allows a
    token minted for this MCP endpoint to be refused anywhere else, should this
    app ever expose a second protected resource.
  */
  resource text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_oauth_codes_expiry on oauth_authorization_codes(expires_at);

/*
  Access and refresh tokens, opaque and stored as hashes.

  Deliberately not JWTs, for the same reason api_tokens is not: a self-verifying
  token cannot be revoked before it expires, and revocation is the property that
  matters when the thing being revoked is somebody's standing connection to the
  whole lead book. One indexed lookup per request is a fair price.
*/
create table if not exists oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  kind text not null check (kind in ('access', 'refresh')),
  client_id text not null references oauth_clients(client_id) on delete cascade,
  user_id uuid not null references user_profiles(id) on delete cascade,
  scope text not null default 'mcp:read',
  resource text,
  expires_at timestamptz not null,
  /*
    The authorization code this token descends from.

    RFC 6749 §4.1.2 says that on detecting a code replay the server SHOULD revoke
    everything already issued from that code, and this column is what makes that
    possible without over-reaching. Without it the only available response to a
    replay is to revoke every token the client and user share, which punishes
    that person's other, legitimate connections for an attack on one of them.

    Not a foreign key: the code row itself is purged within the hour, and this
    has to outlive it to be useful.
  */
  from_code_hash text,
  /*
    Refresh rotation lineage: the token this one replaced.

    Rotation without lineage cannot tell "a client legitimately refreshed twice"
    from "somebody replayed a stolen refresh token". With it, a request against
    an already-rotated token is unambiguous evidence of the second, and the whole
    chain is revoked rather than just the token presented.
  */
  replaces_id uuid references oauth_tokens(id) on delete set null,
  rotated_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists idx_oauth_tokens_hash on oauth_tokens(token_hash) where revoked_at is null;
create index if not exists idx_oauth_tokens_user on oauth_tokens(user_id, kind) where revoked_at is null;
create index if not exists idx_oauth_tokens_expiry on oauth_tokens(expires_at) where revoked_at is null;
/* Only read when a replay is actually detected, which is rare and urgent. */
create index if not exists idx_oauth_tokens_code on oauth_tokens(from_code_hash) where from_code_hash is not null;

/*
  Re-runnable, like every other migration here. `create table if not exists`
  makes the first run safe but does nothing on a second, so a column added to
  this file after somebody applied it would silently never appear. These say so
  explicitly.
*/
alter table oauth_tokens add column if not exists from_code_hash text;
alter table oauth_tokens add column if not exists replaces_id uuid references oauth_tokens(id) on delete set null;
alter table oauth_tokens add column if not exists rotated_at timestamptz;
alter table oauth_authorization_codes add column if not exists resource text;

alter table oauth_clients enable row level security;
alter table oauth_authorization_codes enable row level security;
alter table oauth_tokens enable row level security;

/*
  No policies, on any of the three — not even read, exactly as api_tokens.

  These tables hold credential material and the consent record that authorizes
  it. Every access goes through the service role from a route that has already
  established who is calling; a session should not be able to enumerate the
  tokens that authenticate it, and letting one read hashes buys an attacker
  offline guesses for free.
*/

/*
  Housekeeping. Expired codes and tokens are dead weight rather than a risk —
  every read path already filters on expires_at — but a table that only grows is
  a table that eventually gets noticed for the wrong reason.

  Called opportunistically by the token endpoint rather than scheduled: it is
  two indexed deletes, and tying it to the traffic that creates the rows means
  there is no cron entry to forget.
*/
create or replace function purge_expired_oauth() returns void
language sql
security definer
set search_path = public
as $$
  delete from oauth_authorization_codes where expires_at < now() - interval '1 hour';
  delete from oauth_tokens where expires_at < now() - interval '30 days';
$$;
