# Pending migrations — run in this order

## The order

Run these top to bottom. Each file is idempotent (`create table if not
exists`, `add column if not exists`, `create or replace`), so re-running one is
always safe.

| # | File | Adds |
|---|---|---|
| 1 | `20260726100000_routing_columns.sql` | `route`, `stage`, `assigned_team`, `routed_at` |
| 2 | `20260726110000_priority_and_enrichment_runs.sql` | priority columns, `scoring_policy`, `enrichment_policy`, `enrichment_runs` |
| 3 | `20260726120000_source_credentials.sql` | `source_credentials` (never existed) |
| 4 | `20260726130000_auth_rbac.sql` | `user_profiles`, `owner_user_id`, RLS |
| 5 | `20260726140000_encrypted_secrets.sql` | `app_secrets`, encryption metadata |
| 6 | `20260726150000_lead_lifecycle.sql` | `status` machine, validation + call-prep columns, indexes |
| 7 | `20260726160000_source_config_and_runs.sql` | `source_config`, `ingestion_runs` |
| 8 | `20260726170000_prioritisation.sql` | `enrichment_rules`, `prioritisation_runs`, snooze |
| 9 | `20260726180000_bootstrap_first_admin.sql` | makes the first signup an admin |
| 10 | `20260802100000_apollo_reveal_cache.sql` | `apollo_reveal_cache` — one Apollo credit per person, not per record |
| 11 | `20260802110000_account_research.sql` | `researched_at` + `research_summary` on `account_enrichment` — research a company once, not once per project |

**File 11, likewise optional and likewise pays for itself.** Without it the
brief job still works; it simply cannot tell that a company has already been
researched, so it pays for that research again on every one of that company's
projects. NextEra Energy holds 270 records.

**File 10 is optional but pays for itself.** Without it, reveals still work;
the cache read logs a warning and every reveal is billed again. With it, a
person Apollo has already been asked about is free on every subsequent record.
That matters most where one company owns many projects — four Cleveland-Cliffs
mining records revealed the same three people for twelve credits.

**Validate before running.** `./scripts/test-migrations.sh` applies every
migration to a throwaway Postgres in a Docker container, then re-applies them
to prove idempotency. Run it after touching any migration — it catches the
cross-file and type errors that eyeballing SQL does not.

**Cross-file dependencies are guarded**, so an out-of-order run no longer
aborts: file 6's owner backfill, file 5's `source_credentials` columns and file
4's `account_enrichment` policy each check the object exists first and skip
quietly if it doesn't. Running 6 before 4 simply means owners aren't
backfilled — re-run 6 afterwards to pick them up.

The per-file detail follows.

---

## 1–3. The first three files in detail

| # | File | What it adds | Why it matters |
|---|---|---|---|
| 1 | `migrations/20260726100000_routing_columns.sql` | `route`, `stage`, `assigned_team`, `routing_reason`, `routed_at` | Without it `/records` cannot show or filter lanes, and "Score & route all" fails. |
| 2 | `migrations/20260726110000_priority_and_enrichment_runs.sql` | `priority_score`, `priority_band`, `priority_reasons`, `scored_at`, `enriched_at`, plus the `scoring_policy`, `enrichment_policy` and `enrichment_runs` tables | Without it no lead can be scored or ranked, the enrichment queue is empty, and saving a scoring/enrichment policy from Settings returns "schema cache" errors. |
| 3 | `migrations/20260726120000_source_credentials.sql` | `source_credentials` table + RLS lockdown | **This table was referenced by the app since day one but never defined.** Saving an API key in Settings silently failed. |

After running all three:

1. Open `/settings` and confirm the credential forms render (they read the
   static source catalog, so they appear even before any key is saved).
2. Open `/routing` and click **Score & route all records**. This is what
   populates `priority_score` / `priority_band` on the existing rows — until it
   runs, every record shows as "unscored".
3. Open `/` and `/enrichment` and confirm the "Migration required" notices are
   gone.

## Verifying from the command line

```bash
# Windows/Git Bash needs --ssl-no-revoke; drop it elsewhere.
set -a; . ./.env.local; set +a
curl -sS --ssl-no-revoke \
  "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/canonical_projects?select=id,priority_score&limit=1" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
```

A row with a `priority_score` key (even `null`) means migrations 1–2 landed.
`{"code":"42703"...}` means they have not.

```bash
curl -sS --ssl-no-revoke -o /dev/null -w '%{http_code}\n' \
  "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/source_credentials?select=source_key&limit=1" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
```

`200` means migration 3 landed; `404` means it has not.

## Tables deliberately NOT recreated

`source_registry` and `icp_definitions` are **retired**, not missing. The
single-table model replaced them: `src/lib/sourceCatalog.ts` supersedes the
registry, and ICP data now lives on `canonical_projects.icp_code`. The dead
query functions and the orphaned `/icps/[code]` page that depended on them have
been removed. Do not recreate these tables.

---

## 4. `migrations/20260726130000_auth_rbac.sql` — authentication and RLS

Adds `user_profiles` (six roles), `owner_user_id` on `canonical_projects`, the
role-helper functions, and Row Level Security on every table holding leads or
configuration.

**Until this runs the app is in "setup mode": every page is publicly readable
and a red banner says so on every screen.** That is deliberate — before the
migration there are no users to sign in as and no RLS to enforce, so blocking
every request would only lock a working install out of itself. Applying the
migration flips enforcement on automatically.

### After running it

1. Open `/signin` and create your account (magic link, or invite yourself).
2. The **first** account to sign up is made an admin automatically (migration
   9), so no SQL is needed. Every account after that gets `bdr`, and the admin
   assigns roles from `/control/users`.

3. The banner disappears, `/control` opens, and you can invite the team.

   If you somehow end up with no admin at all, re-running migration 9 promotes
   the earliest profile.

### Verifying RLS actually bites

```bash
set -a; . ./.env.local; set +a
curl -sS --ssl-no-revoke -o /dev/null -w '%{http_code}\n' \
  "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/canonical_projects?select=id&limit=1" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" \
  -H "Authorization: Bearer $NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
```

Before the migration this returns `200` with data. Afterwards an anonymous
request returns `200` with an **empty array** — the rows exist but no policy
grants them to `anon`. That empty result is the proof RLS is on.

---

## 5. `migrations/20260726140000_encrypted_secrets.sql` — encrypted key storage

Adds `app_secrets` (platform-wide keys: Anthropic, Apollo, Hunter, Twilio) and
the encryption metadata columns on `source_credentials`. Both are locked to the
service role — RLS on, no policy granted, so `anon` and `authenticated` cannot
read a row under any query.

### Where the master key comes from

Encryption needs a root of trust, and storing it beside the ciphertext would be
pointless. By default the key is **derived (HKDF-SHA256) from the Supabase
service-role key**, which the app already needs to reach the database — so no
new environment variable is introduced, satisfying the "no env vars beyond the
DB connection" rule.

Two optional overrides exist for installs that want the encryption key
separated from the database key:

| Variable | Purpose |
|---|---|
| `CREDENTIALS_MASTER_KEY` | Use this instead of deriving from the service key |
| `CREDENTIALS_MASTER_KEY_PREVIOUS` | The prior key, so old rows still decrypt during a rotation |

**Note the consequence of the default:** rotating the Supabase service-role key
changes the derived encryption key, and previously stored secrets stop
decrypting. If you rotate the service key, set the old one as
`CREDENTIALS_MASTER_KEY_PREVIOUS`, run **Re-encrypt** in Settings, then remove
it. Setting an explicit `CREDENTIALS_MASTER_KEY` avoids the coupling entirely.

### After running it

1. Open `/control/settings` → **API Keys**.
2. If keys still live in `.env.local`, click **Import from env** — they are
   encrypted into the database, after which the variables can be deleted. The
   button covers both stores: `app_secrets` (platform keys) and
   `source_credentials` (the four keyed adapters).
3. Existing plaintext rows in `source_credentials` keep working (the reader
   passes non-envelope values through) and are upgraded on their next save, or
   all at once via **Re-encrypt**.

**Nothing resolves from the environment any more.** The DB → env fallback was
removed from `adapters/credentials.ts`, `adapters/credentialStatus.ts` and
`crypto/store.ts`, so a key left only in `.env.local` will look configured and
resolve to nothing. On a headless upgrade — or when the removal has taken
Google sign-in's own credentials out of play and you cannot reach Settings —
import from the command line instead, which is the safe order:

```bash
npm run import:secrets     # idempotent; already-stored keys are skipped
npm run verify:secrets     # asserts every keyed source resolves from the DB
```

`verify:secrets` also cross-checks that what Settings reports and what the
adapter actually receives agree — the failure mode otherwise shows up as a 401
from a vendor mid-ingestion rather than as anything visible in the UI.

### Rotation without downtime

Each ciphertext records the id of the key that produced it, and decryption
accepts any key in the active set. So a rotation is: set the old key as
`CREDENTIALS_MASTER_KEY_PREVIOUS`, set the new one as `CREDENTIALS_MASTER_KEY`,
restart, then run **Re-encrypt** — rows migrate in the background while the old
key still serves anything not yet converted. No flag day.

---

## 6. `migrations/20260726150000_lead_lifecycle.sql` — lifecycle and schema

Adds the `status` column (the RAW → CONVERTED/LOST machine in
`src/lib/lifecycle.ts`), one timestamp per transition, phone/email validation
columns, call-prep output, the `enrichment_history` audit trail, and five
composite indexes.

### The `processing_status` reconciliation

The old column mixed pipeline mechanics with sales progress, so the backfill
interprets rather than copies:

| `processing_status` | → `status` | why |
|---|---|---|
| `ingested`, `normalized`, `scored`, `routed` | `RAW` | pipeline mechanics — nothing has been *spent* on the record |
| `enriching` | `ENRICHING` | direct match |
| `enriched` | `ENRICHED` | direct match |
| `qualified` | `ASSIGNED` | a qualified lead has an owner |
| `failed`, `duplicate` | `LOST` | neither will ever be worked |

The backfill only touches rows still at the default `RAW`, so re-running the
migration never clobbers real progress. `processing_status` is marked
deprecated with a SQL comment and kept for one release; nothing writes to it.

### Indexes

Five, matching the queries the app actually issues:

- `(bu, vertical, status, priority_score desc)` — the scoped working list
- `(status, priority_score desc)` — the enrichment queue
- `(owner_user_id, status, priority_score desc)` — an owner's own leads
- `(status, created_at desc)` — activity feed and daily-cap counting
- a partial index on unverified contacts — small and hot

Without these, every scoped read is a sequential scan of the whole table.

### After running it

Records gain a **Status** column and filter. Enrichment claims only idle
records (`RAW`, `PENDING_ENRICHMENT`, `ENRICHED`), so a second worker cannot
double-spend on one already `ENRICHING`, and terminal leads are never revived.

---

## 7. `migrations/20260726160000_source_config_and_runs.sql` — ingestion control

Adds `source_config` (per-adapter enable/schedule/quota/dedupe plus rolling
health) and `ingestion_runs` (one row per run, for history and live progress).

### A bug this fixes

`/api/ingest/[source]` wrote health to **`source_registry`** — the table retired
with the single-table model. Those updates silently no-oped, so every source
appeared permanently unconfigured no matter how many times it ran. Health now
lands on `source_config`, which `/control/seeding` actually reads.

**The GEM path had the same bug and was missed by that fix** (`lib/gem/ingest.ts`,
corrected 2026-07-30). It was worse than a stale table name: the update filtered
on `source_key`, which is not `source_config`'s key either — that is the `slug`
(`gem`, not `gem_energy_tracker`). PostgREST answers a no-op update with a 2xx,
so nothing anywhere surfaced it.

GEM now records health *and* run history through the same `recordRunOutcome` /
`startRun` / `finishRun` helpers as every adapter, so uploads appear on the
Source Hub with latency and last error like anything else. Failures are recorded
too, not only successes — the rolling status needs 3 consecutive failures to read
`failing`, which could never have triggered when nothing reported a failure.

Ingesting the folder for the first time surfaced three more defects in the same
path, all of which had been there since the beginning:

| Defect | Effect |
|---|---|
| `upsertRecords` never deduped a batch | GEM publishes at unit/phase grain while `source_unique_id` resolves to the site, so 11 of the 18 files contained duplicate conflict keys. Postgres rejects those outright (`ON CONFLICT DO UPDATE command cannot affect row a second time`) — **those 11 trackers had never ingested at all.** Duplicates are now collapsed onto the site and the count is reported, not swallowed. |
| The existence probe put 500 ids in a GET URL | The request failed, the error was discarded, and the result read as "none exist" — so a re-ingest of 2,009 unchanged records reported 2,000 *inserted*. Probing is now chunked at 100 and propagates its error. Data was always correct; only the numbers were wrong. |
| Health keyed on records normalized | Normalizing is not persisting. A run where 11 files failed at the upsert reported `healthy`. Any file-level error now makes the run unhealthy, with the filename in `last_error`. |

Grain is a **product decision, not a detail**: `ID_KEYS` in `gem/normalize.ts` is
ordered location-first on purpose, so a four-reactor station is one lead rather
than four. 4,216 of 20,524 rows collapse as a result. Reordering that list
changes what a GEM lead means — read the comment there before touching it.

Guarded by `npm run verify:gem` (30 checks). It has to hit a real database,
because the original defect was a write that succeeded and matched nothing; only
reading the row back catches that. It snapshots `source_config` and asserts on
deltas, so it is safe to run against an install with real GEM history, and it
restores the snapshot and verifies its own cleanup on the way out.

`npm run ingest:gem` loads `data/gem` from the command line (the Source Hub
button needs a signed-in admin; this does not). `--dry` reports what would land
per tracker without writing — worth running first, since the record count is not
obvious from the file sizes.

### How health is derived

Rolling counters, never set by hand, and deliberately hysteretic so a single
vendor blip doesn't turn a row red:

| Condition | Status |
|---|---|
| disabled | `disabled` |
| never run | `unconfigured` |
| 3+ consecutive failures | `failing` |
| any recent failure, or >25% error rate, or no success in 7 days | `degraded` |
| otherwise | `healthy` |

### After running it

`/control/seeding` lists all 23 adapters with health, quota use, average
latency and last error. Each row has **Run now** and a collapsed **Configure**
panel (mode, cron, monthly cap, page size, max per run, dedupe strategy). A
disabled source or one over its monthly cap refuses to run, with the reason
returned rather than a silent no-op.

Run history and the error log fill in from the first run onward.

---

## 8. `migrations/20260726170000_prioritisation.sql` — selection rules

Adds `enrichment_rules` (the admin rule list), `prioritisation_runs` (daily
selection history) and per-record `snoozed_until` / `force_enrich` /
`selected_by_rule`.

### Why selection is separate from enrichment

`/api/prioritize` only moves records `RAW → PENDING_ENRICHMENT`. It is cheap
and idempotent; enrichment is what costs money. Splitting them means the queue
can be reviewed and trimmed **before** any spend, and a preview costs nothing.

### How the rules allocate

Rules run in `priority` order (1 first). Each takes matching records — best
score first — up to its own `dailyLimit`, then the next rule works on what
remains. Two guarantees fall out of that:

- **A record is claimed once.** Overlapping rules degrade to "first rule wins",
  never to double spend.
- **A budget shortfall costs the weakest cohort, not a random slice.** When the
  per-rule limits exceed the global cap, the highest-priority rules are
  satisfied first and the rest are *deferred to tomorrow*, not dropped.

The global cap is the policy's `dailyCap` **minus what was already enriched
today**, so a second run in one day cannot queue a second full day's budget.

### Snooze vs disqualify

Snoozing defers a record without disqualifying it — it stays eligible and is
simply skipped until the date passes. Before this, the only way to get a record
out of today's queue was to mark it `LOST`.

### After running it

`/control/enrichment` gains **Daily prioritisation** with a preview that shows
the per-rule breakdown: how many each rule claimed, and how many it matched but
couldn't take. Selection history appears beneath it.

---

## 10. `migrations/20260726190000_assignment.sql` — lead distribution

Adds `assignment_rules`, `assignment_history` and the SLA columns
(`sla_due_at`, `sla_breached`, `first_contact_at`, `last_action_at`).

### Ownership is append-only

Overwriting `owner_user_id` loses who held a lead and why it moved — the first
thing a manager asks when one stalls. Every change writes an
`assignment_history` row, so reassignment is auditable rather than destructive.

### How leads are distributed

Rules match on the lead's shape and target a user or a role. Within a role the
lead goes to whoever has the **most remaining headroom**, so work spreads
instead of filling one person first. Highest-priority leads are placed first,
so when capacity runs out it is the weakest that wait — the same principle as
enrichment selection.

Guarantees covered by `npm test` (18 checks):

- an owner's daily quota is never exceeded
- a lead is never assigned twice, and an already-owned lead is never reassigned
- a named target outside their scope is skipped, not forced
- an empty scope means "no restriction", not "no leads" — otherwise a newly
  invited user would silently receive nothing

### SLA

The deadline is stamped **at assignment** from the routing rule's `sla_hours`,
so a later policy change never retroactively breaches leads already in flight.
`first_contact_at` is stamped once, keeping time-to-first-contact honest when a
lead is worked repeatedly.

### After running it

`/records` gains an Owner filter (Mine / Everyone / Unassigned), an SLA column
and per-lead actions. `/control/team` shows load per seller and runs the
assignment pass.

---

## 11–12. Apollo export and the scheduler

`20260726200000_apollo_export.sql` — `export_runs` plus per-lead
`apollo_exported_at` / `apollo_contact_id` / `apollo_export_status`.

`20260726210000_cron_runs.sql` — a log of every scheduled run.

### Export is guarded against double sends

Apollo's `bulk_create` is not idempotent from our side: sending a contact twice
adds noise to the destination list. `apollo_exported_at` is stamped **on
success only**, and the query filters on it — so a failed lead stays eligible
for the next run instead of being silently skipped, and a successful one is
never sent again.

"Already existing in Apollo" is recorded as `existing`, not as a failure, so it
doesn't inflate the error rate.

Eligibility is deliberately strict: a lead needs an owner, a **verified**
email, and a worked status. Exporting unowned or unverified contacts pollutes
the sales tool with records nobody is working.

### Turning the scheduler on

Nothing ran on a schedule before this — the per-source cron expressions were
stored and validated but never fired. Set `CRON_SECRET` in `.env.local`:

```
CRON_SECRET=<a long random string>
```

Then point any scheduler at it:

```bash
curl -X POST "https://your-app/api/cron?job=daily" \
     -H "Authorization: Bearer $CRON_SECRET"
```

Jobs: `ingest` (sources whose schedule is due), `prioritise` (select
tomorrow's queue), `export` (push to Apollo), `daily` (all three in dependency
order — ingest brings records in, prioritisation selects from what is there,
export sends what has been worked).

**With no `CRON_SECRET` set the endpoint refuses to run at all**, so an
unprotected deployment cannot have its jobs triggered by anyone who finds the
URL. The secret is compared in constant time and is the one value that stays an
environment variable — the scheduler has to authenticate before any database
read can happen, so it cannot come from the encrypted store.

The Control Center reports when the scheduler was last heard from, because a
scheduler that silently stops looks exactly like a quiet period.
