# Google sign-in

Sign-in is Google, spoken directly. Supabase Auth is not involved — Supabase is
the database and nothing else. There is no password, no magic link and no
`auth.users` row.

## What did not change

Every RLS policy. `auth.uid()` reads the `sub` claim of whatever JWT PostgREST
was handed; it never consulted `auth.users`. The session this app issues is
signed with the project's own JWT secret and carries the same claims Supabase
used to send, so Postgres cannot tell the difference. Eighteen policies, three
migrations of `auth.uid()` references, and every ownership rule kept working
untouched.

## The flow

```
/signin
  → GET /api/auth/google/start        mints state + nonce, sets 3 short cookies
  → accounts.google.com               the visitor picks an account
  → GET /api/auth/google/callback     state checked (constant-time)
                                      code exchanged at Google's token endpoint
                                      id_token verified against Google's JWKS
                                      aud / iss / exp / nonce / email_verified checked
  → admit_google_user()               SQL: allow-list, first-admin, find-or-create
  → ldr_session cookie                HS256, 8h, httpOnly, sameSite=lax
  → wherever they were going
```

The proxy re-issues the token once it is inside its last hour, so an active
session never expires mid-task. Signing out deletes the cookie; there is no
session table to fall out of step with it.

## 1. Google Cloud — create the OAuth client

<https://console.cloud.google.com/apis/credentials> → **Create credentials** →
**OAuth client ID** → **Web application**.

Authorised redirect URIs — these now point at **this app**, not at Supabase:

```
https://your-app-domain/api/auth/google/callback
http://localhost:3000/api/auth/google/callback
```

A missing entry here is the single most common failure; the sign-in page names
it specifically rather than saying "something went wrong".

## 2. Settings — paste three values

**Control Center → Settings**. Nothing goes in `.env.local`; these are stored
AES-256-GCM encrypted in `app_secrets` like every other credential.

| Secret | Where it comes from |
| --- | --- |
| Google OAuth — client ID | the OAuth client above |
| Google OAuth — client secret | the OAuth client above |
| Supabase JWT secret | Supabase dashboard → Project Settings → API → JWT Secret |

The JWT secret is what makes the session acceptable to Postgres. Without it the
app can authenticate someone and then not be able to issue them a session — the
sign-in page says exactly that.

> Projects created with asymmetric JWT signing keys have no symmetric JWT
> secret to copy. Legacy HS256 has to be enabled for the project, or the token
> signing in `src/lib/auth/jwt.ts` moved to RS256 with the project's private
> key.

## 3. Migrations

```
supabase/migrations/20260729100000_google_oauth.sql    domain allow-list
supabase/migrations/20260729110000_own_google_auth.sql detaches from auth.users
```

The second one drops the `auth.users` foreign key on `user_profiles` and gives
the column its own default. Existing rows keep their ids, so every
`owner_user_id`, `assignee_id` and `from_user_id` still points at the same
person.

## 4. Decide who gets in

**Control Center → Team → Sign-in access.**

The Google button is public: anyone with any Google account can press it.
Admission is by email domain, enforced in `admit_google_user` rather than in a
route, so a mistake in TypeScript cannot widen it.

- **Domain on the list** — active on first sign-in, role `bdr`.
- **Anything else** — a profile is created so an admin can see the request, but
  inactive. `requireUser`, `checkPermission`, the proxy and RLS all refuse it;
  the visitor sees "waiting for approval" rather than a silent bounce. Approve
  with **Enable** in the Members table.
- **Empty list** — nobody is admitted automatically. Safe default.
- **The first account** is exempt and becomes admin, so a fresh install cannot
  lock its own owner out.
- **Pre-authorised** — *Grant access ahead of time* writes the profile with a
  role now; first sign-in updates that row rather than creating a second, so
  the role sticks and the domain rule is bypassed for that address.

Removing a domain never disables anyone already active.

## Verifying

```bash
./scripts/test-google-admission.sh                  # admission, against real Postgres
node --experimental-transform-types --no-warnings \
  --import ./scripts/lib/register-alias.mjs \
  scripts/test-jwt.mjs                              # the session token
node --experimental-transform-types --no-warnings \
  --import ./scripts/lib/register-alias.mjs \
  scripts/test-auth-domains.mjs                     # the allow-list input
```
