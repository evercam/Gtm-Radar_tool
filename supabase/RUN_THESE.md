# Migrations — what to run, and what has already been run

## Nothing is outstanding as of 2026-08-18

Every migration in `supabase/migrations/` is applied to production. Verified
against the live database rather than from these notes:

| Applied | Verified by |
|---|---|
| `20260813120000_drop_unread_indexes.sql` | the ingest upsert timeouts it targets |
| `20260817120000_mcp_oauth.sql` | `oauth_clients`, `oauth_tokens`, `oauth_authorization_codes`, `purge_expired_oauth()` |
| `20260818120000_pipeline_rollup_rpc.sql` | `pipeline_rollup()` answers in 0.5 s |
| `20260818160000_dashboard_rollup.sql` | `dashboard_rollup()` answers in 0.6 s |
| `20260818180000_source_stats_rollup.sql` | `source_stats()` returns 26 sources |
| `20260818200000_kpi_snapshots.sql` | `kpi_snapshots` holds a row per window |

`20260818140000_pipeline_rollup_index.sql` was **never applied and should not
be** — `20260818160000` supersedes it with one wider index covering both
aggregates. Its section below is kept for the reasoning, marked as superseded.

**A section headed `APPLIED` is history, not a task.** These notes were briefly
worse than useless in the other direction: every section said `PENDING` long
after the migration had been run, which is exactly how somebody ends up
re-running SQL or deciding the file cannot be trusted. If you add a migration
here, mark it `PENDING` while it is, and change the heading the day it lands.

## The order

If you are rebuilding from scratch, run these top to bottom. Each file is
idempotent (`create table if not exists`, `add column if not exists`, `create or
replace`), so re-running one is always safe.

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
| 12 | `20260803100000_repair_stale_enriched_status.sql` | repairs the status of records enriched while the transition was broken |
| 13 | `20260804090000_export_field_policy.sql` | `export_field_policy` — makes the Apollo custom-field mapping editable from Settings |

**File 13 is what stops the export losing content silently.** The mapping from
our fields to Apollo custom fields was hardcoded, matched by name, and two of
its seven entries no longer resolve to anything a contact write can land in:
`Qualify Account` and `evercam_us_project_signal` are modality `account`, so
Apollo accepts them on a contact and discards them. The ICP score, trigger
event and pain point were therefore "sent" on every export and never arrived.
Until this runs, Settings still renders the mapping and still reports which
fields cannot receive a write — it just cannot save a correction, because there
is nowhere to put it. The export keeps using the built-in defaults.

**File 12 changes data, not schema — the only one here that does.** It moves 380
records that carry `enriched_at` while still reading RAW or Queued onto the
status their own timestamps prove they reached. Until it runs, those leads look
like unenriched stock to the queue, which will offer to pay for them a second
time. It skips anything deliberately re-queued after enrichment (`queued_at`
later than `enriched_at`), so a real staleness refresh is never cancelled.

**File 11, likewise optional and likewise pays for itself.** Without it the
brief job still works; it simply cannot tell that a company has already been
researched, so it pays for that research again on every one of that company's
projects. NextEra Energy holds 270 records.

**File 10 is optional but pays for itself.** Without it, reveals still work;
the cache read logs a warning and every reveal is billed again. With it, a
person Apollo has already been asked about is free on every subsequent record.
That matters most where one company owns many projects — four Cleveland-Cliffs
mining records revealed the same three people for twelve credits.

## Scheduling: the hourly runs this pipeline is sized for

Enrichment fills a buffer of `apolloBatchSize x exportBufferMultiple` (10 x 24 =
240) and stops. At ten records per run that is twenty-four runs — one day of
hourly firings — which is where the 24 comes from.

**Vercel Hobby plans allow daily crons only.** An hourly entry in `vercel.json`
is rejected at deploy time ("Hobby accounts are limited to daily cron jobs"), so
the schedule cannot live there on the current plan. `vercel.json` therefore holds
only the daily 06:00 chain.

The buffer gate itself is plan-independent and already enforced: any caller
hitting the endpoint gets one batch if the tank has room, and a reason if it does
not. So the hourly cadence can come from anywhere.

Two ways to get it:

1. **Upgrade to Vercel Pro**, then add to `vercel.json`:

   ```json
   { "path": "/api/cron?job=enrich", "schedule": "0 * * * *" },
   { "path": "/api/cron?job=brief",  "schedule": "30 * * * *" }
   ```

2. **Drive it externally** — GitHub Actions, cron-job.org, anything that can send
   a header:

   ```
   curl -X POST "https://evercam-raddar.vercel.app/api/cron?job=enrich"      -H "Authorization: Bearer $CRON_SECRET"
   ```

Until one of those is in place the pipeline runs once a day, so a 240 buffer takes
24 days to fill rather than one. Nothing is broken by that — the gate simply sees
room every morning and enriches ten.

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

---

## APPLIED 2026-08-18 — `20260813120000_drop_unread_indexes.sql`

**Run this one. It is why thirteen of twenty-five sources lose their data every
night.** Measured 2026-08-13 from `ingestion_runs`: glenigan failed 11 of 13 runs,
sec-edgar 7 of 14, nyc-permits 7 of 9, chicago-permits 5 of 9, planning-ie 5 of 9 —
all on `canceling statement due to statement timeout` during the upsert. The
records are fetched correctly and then thrown away.

`canonical_projects` carries 48 indexes, so every upserted row updates all 48. Two
are GIN indexes over JSONB, one of them covering `raw_data` — the entire source
payload and the largest column on the table. GIN maintenance walks and tokenises
the whole value on every insert and update. That is why austender timed out on
"records 0-52 of 52" and electrive on "records 0-30 of 30": thirty rows cannot time
out on their own merit, so the cost is per row, not per batch.

Nothing reads any of the four. Each drop is justified by a grep, and four further
candidates were checked and KEPT because they are load-bearing — see the comments
in the migration file itself.

Paste into the Supabase SQL editor:

```sql
drop index if exists public.idx_projects_raw_gin;
drop index if exists public.idx_projects_provenance_gin;
drop index if exists public.idx_projects_composite;
drop index if exists public.idx_projects_status;
```

Safe on a live table: dropping an index takes a brief lock, not a rebuild, and
these are all non-constraint indexes. Reversible — every `create` statement is in
`supabase_setup.sql` and `20260725133256_init_canonical_projects.sql`.

Verified against a throwaway Postgres with every prior migration applied: all four
present before, none after, the four load-bearing ones still present, 48 indexes
down to 46. `npm run test:migrations` passes the whole chain and re-applies it
cleanly.

**It cannot be applied from a dev machine without IPv6 egress.** The pooler host
`aws-0-eu-west-3.pooler.supabase.com` accepts TCP but no Postgres handshake
completes — six combinations across ports 5432 and 6543, with and without explicit
SSL, all time out at 15s while the REST API on 443 works normally. Use the SQL
editor, or a machine that can reach the pooler.

### Confirming it worked

There is no need to inspect `pg_indexes`. The next scheduled ingest is the test:

```sql
select slug, started_at, fetched, inserted, error_kind, left(error, 80)
from ingestion_runs
where started_at > now() - interval '1 day'
order by started_at desc;
```

Before: thirteen sources with `error_kind` set and `fetched` counts discarded.
After: the upsert timeouts should be gone. The two remaining failures are network
blocks that no migration touches — `public-contracts-scotland` and `mining-com`
both work locally and are refused from Vercel's `cdg1` egress.

---

## APPLIED 2026-08-17 — `20260817120000_mcp_oauth.sql`

**Nothing breaks until you want to connect an assistant from claude.ai.** This is
additive: three new tables and one function, no changes to anything that exists.
The HTTP MCP endpoint keeps working exactly as it does now for static `gtm_`
tokens and for a signed-in tab.

What it unlocks is the other way in. claude.ai's connector UI has nowhere to paste
a bearer token — it speaks OAuth or nothing — so before this, adding the endpoint
as a custom connector failed with:

> Couldn't register with Evercam Radar's sign-in service. You can try again, or add
> an OAuth Client ID in the connector settings.

That message is the client having probed for an OAuth server, found none, guessed
that the MCP origin was one, posted its registration to `/register`, and been
handed the sign-in page. Adding an OAuth Client ID does not fix it — there was no
authorization server to have a client ID *for*.

| Table | Holds | Lifetime of a row |
|---|---|---|
| `oauth_clients` | a registered application | until revoked |
| `oauth_authorization_codes` | one approval in flight | 2 minutes |
| `oauth_tokens` | access and refresh tokens | 8 hours / 30 days |

Storage follows `api_tokens`: only SHA-256 hashes, RLS on with **no policy at
all**, every access through the service role from a route that has already decided
who is asking.

### The property worth having

A token from this flow belongs to a **person**, and its permissions are read from
their role on every request rather than baked in at issue time. So narrowing a
role narrows their connector immediately, and deactivating an account stops it —
at the same moment it stops their browser, with nothing to remember. A shared
`gtm_` token cannot do either, which is why handing one round to colleagues would
have quietly collapsed the per-role model the endpoint is built on.

### Registration is open, and that is deliberate

Anyone can POST to `/api/oauth/register` without a credential. It has to be that
way — a hosted client that has never heard of this deployment cannot be issued a
client ID out of band. What it yields is an identifier that **authorizes nothing**.
Reading a single row additionally requires an active Evercam Radar account, an
explicit approval on the consent screen, a return to an address fixed at
registration time, and the matching PKCE verifier. An unapproved registration is
an inert row; the rate limit (40/hour) is there to stop those rows accumulating,
not to protect data.

Paste into the Supabase SQL editor:

```
supabase/migrations/20260817120000_mcp_oauth.sql
```

It is one file and it is idempotent — `create table if not exists` throughout,
plus explicit `add column if not exists` for every column, so re-running it is
always safe.

Verified against a throwaway Postgres with all 30 prior migrations applied:
`npm run test:migrations` passes the whole chain and re-applies it cleanly.

### Confirming it worked

Registration is the test, and it needs no browser:

```bash
curl -s -X POST https://<your-app>/api/oauth/register \
  -H 'content-type: application/json' \
  -d '{"client_name":"probe","redirect_uris":["https://example.com/cb"]}'
```

Before: `503 {"error":"temporarily_unavailable","error_description":"Run the MCP
OAuth migration first."}` — which is also the exact 503 that surfaces in Claude as
the "couldn't register" message above.

After: `201` with a `client_id`. Delete the probe row afterwards if you like; an
unapproved client can read nothing, so leaving it costs only the row.

Then add the connector in Claude: *Settings → Connectors → Add custom connector*,
give it `https://<your-app>/api/mcp`, and **leave the OAuth client ID and secret
fields empty**. It registers itself and opens the approval page here.

### What to watch

`Settings → Connected assistants` lists every live connection with the person it
reads as and when it was last used, and disconnects any of them. A connection that
nobody recognises is the thing to look for; there is no legitimate way for one to
appear without somebody having approved it while signed in.

---

## APPLIED 2026-08-18 — `20260818120000_pipeline_rollup_rpc.sql`

> **Outcome:** `pipeline_rollup()` answers in 0.5 s. summarise_pipeline 64-114 s -> 1.3 s.
> Note this migration alone was NOT enough — it needed the covering index that
> `20260818160000` ended up providing.

**Run this to make `summarise_pipeline` usable from a connector.** It is additive:
one function and two grants, no table touched, nothing dropped. The tool keeps
working without it — just slowly, on the fallback path.

`summarise_pipeline` pulled the whole table across the wire to produce twelve
numbers. Measured against 109,552 rows: **64 s, 72 s and 81 s** on three runs, and
one of those exceeded Supabase's statement timeout outright. Any connector gives
up long before that, so the tool reads as broken even when it eventually answers.

Two separate faults, and fixing either alone leaves it slow:

| Fault | Why it costs |
|---|---|
| `.range(p*1000, …)` offset paging | Postgres produces and discards every row before the window, so page 110 pays for the previous 109,000 |
| Transferring 109,552 rows at all | Even by keyset, 110 sequential round trips at ~700 ms is ~77 s |

Both are now moot: the grouping happens in SQL and one round trip returns ~12
rows instead of 109,552.

### Why it groups by the raw columns

Phase and party are normalised in TypeScript, not SQL — 117 raw phase strings map
to 11 through an exact table plus regex rules in `lib/phase.ts`, and that mapping
is **not invertible**, so there is no list of raw values to put in a `WHERE`
clause. The function therefore groups by the raw columns and the caller folds the
result into the normalised vocabulary. That keeps ONE definition of what a phase
is rather than a second one in SQL that would drift from it.

Exactness is unchanged. Every row is still counted; the counting moves to where
the rows already are, and the page-cap `truncated` warning becomes permanently
false because there is no cap to hit.

Paste into the Supabase SQL editor:

```
supabase/migrations/20260818120000_pipeline_rollup_rpc.sql
```

`create or replace function`, so re-running it is safe.

Verified against a throwaway Postgres with all 32 prior migrations applied and
1,000 synthetic rows — the function's arithmetic agrees with the table it counts:

```
 table_rows | rollup_sum | roll_assigned | real_assigned | roll_exported | real_exported | rollup_rows
       1000 |       1000 |           333 |           333 |           250 |           250 |          12
```

Twelve rows out for a thousand in, which is the whole point. `npm run
test:migrations` passes the chain and re-applies it cleanly.

### Confirming it worked

Ask the tool and watch the clock:

```bash
npm run test:mcp
```

Before: four failures, all `summarise_pipeline` — the suite allows 60 s and the
tool needed 64-81 s. After: it should answer in a couple of seconds and those four
pass. The totals must not change; if `records` no longer equals the row count in
`canonical_projects`, stop and say so rather than trusting the faster number.

**`list_sources` is NOT fixed by this** and still takes ~73 s. It walks the same
table through `getSourceStats` in `lib/queries.ts`, which already uses keyset
paging, so it needs its own aggregate. Same shape of fix, separate change.

---

## SUPERSEDED, never applied — `20260818140000_pipeline_rollup_index.sql`

> **Do not run this.** `20260818160000_dashboard_rollup.sql` replaced it with one
> wider index covering both aggregates, rather than two indexes taxing every
> upsert. Kept only because the diagnosis below — why an aggregate over a 492 MB
> table dies at the statement timeout without a covering index — is the reasoning
> behind every rollup index in this file. What follows was written while it was
> still the plan.

`pipeline_rollup()` is now installed and it dies at the statement timeout:

```
select * from pipeline_rollup();
-- 8.8 s, 57014 canceling statement due to statement timeout
```

So `summarise_pipeline` pays 8.8 s for the failed aggregate and then falls back to
walking the table anyway. Measured after applying it: **114 s**, where the old path
alone was 64-81 s. Totals stayed exact (109,552) — it just got slower.

### Why

`canonical_projects` is **134 columns, ~4.7 KB a row — roughly 492 MB** across
109,552 rows. A `GROUP BY` with no usable index is a sequential scan of all of it,
and nothing reads half a gigabyte inside an 8-second budget. For scale, a bare
`count(*)` on this table takes 5.4 s even when served by the primary key.

This is precisely what `20260811160000_disposition_rollup_rpc` already recorded —
*"Without them every count is a sequential scan of the whole table, and no amount
of restructuring the client fixes that"* — and that migration added indexes
alongside its `GROUP BY`. The previous one did not, and repeated the mistake its
own neighbour had documented.

### What this adds

| Change | Why |
|---|---|
| `idx_projects_rollup` covering the 7 rollup columns | lets the aggregate run as an **index-only scan** — ~10 MB of index instead of ~492 MB of heap |
| `statement_timeout = '30s'` on the function | backstop only, for when the visibility map is stale after a bulk load and an index-only scan degrades to heap fetches |

Verified against a throwaway Postgres with the whole chain applied and 20,000
synthetic rows — the plan is the one intended, not merely a hope:

```
HashAggregate
  Group Key: current_phase, priority_band, vertical, bu, icp_code,
             (assignee_id IS NOT NULL), (apollo_exported_at IS NOT NULL)
  ->  Index Only Scan using idx_projects_rollup on canonical_projects
```

Totals unchanged: 20,000 rows in, 20,000 counted, 12 aggregate rows out.

### It costs the ingest a little, deliberately

An extra index is extra work on every upsert, and the nightly ingest is currently
fighting upsert timeouts — `20260813120000` dropped four indexes to relieve exactly
that. This one is a narrow btree of about 10 MB; the four dropped were GIN indexes
over jsonb, which cost orders of magnitude more per row. Real cost, small, and the
reason the index is minimal rather than a comfortable superset.

Paste into the Supabase SQL editor:

```
supabase/migrations/20260818140000_pipeline_rollup_index.sql
```

`create index if not exists` and `create or replace function`, so re-running is
safe. Building the index locks writes on the table briefly; if the nightly ingest
is running, wait for it.

### Confirming it worked

```bash
npm run test:mcp
```

The four `summarise_pipeline` failures should pass, and the tool should answer in
around a second rather than 114. **Check `records` still reads 109,552** — a faster
number that is also a different number is a bug, not a win.

---

## APPLIED 2026-08-18 — `20260818160000_dashboard_rollup.sql`

> **Outcome:** `dashboard_rollup()` answers in 0.6 s. getBuRollup 73.7 s -> 0.9 s,
> getPipelineRollup 74.6 s -> 4.5 s, both still totalling 109,552.

**Run this one; it SUPERSEDES `20260818140000` — skip that file.** The dashboard
does not render, and this is why.

`app/page.tsx:134` blocks on a `Promise.all` of five reads and waits for the
slowest. Measured against 109,552 rows:

| Function | Time |
|---|---|
| `getPipelineRollup` | **74.6 s** — walks the whole table |
| `getBuRollup` | **73.7 s** — walks the whole table |
| `getTopPriorityLeads` | 0.4 s |
| `getDispositionRollup` | 1.1 s — already an RPC with indexes |
| `hasPriorityColumns` | 0.7 s |

So the shell cannot paint for ~75 seconds and the page reads as permanently
loading. `getDispositionRollup` at 1.1 s is the same table and the same shape of
question, already fixed on 11 August — this applies that fix to the two left
walking.

`getKpiSummary` is 42 s and is **not** why nothing renders: it already sits behind
a Suspense boundary and streams in late. Worth fixing next, separately.

### Why it supersedes 20260818140000

That migration added a 7-column index for `pipeline_rollup` alone. A second index
for the dashboard's columns would mean two indexes maintained on every upsert, on
a table whose nightly ingest is already timing out on writes. This uses **one wider
index covering both aggregates** — ~20 MB and one write cost instead of ~23 MB and
two — and drops the narrow one if it exists. Since 140000 was never applied, there
is nothing to undo.

Paste into the Supabase SQL editor:

```
supabase/migrations/20260818160000_dashboard_rollup.sql
```

`create index if not exists` and `create or replace function`, so re-running is
safe. Building the index locks writes on the table briefly — wait if the nightly
ingest is running.

### What is verified, and what is not

Verified against a throwaway Postgres with the full chain and synthetic rows: the
migration applies, is idempotent, and both aggregates' arithmetic agrees with the
table they count — 20,000 rows in, 20,000 counted by each, and `reachable` matching
a direct count exactly.

**NOT verified: that the query planner will choose the index.** The synthetic table
is mostly nulls, so it is a few MB rather than 492 MB, and a sequential scan
genuinely wins there — the sandbox cannot reproduce the row width that makes an
index-only scan the cheap option. On the real table the ratio is ~20 MB of index
against ~492 MB of heap, which the cost model should favour heavily, but that is
reasoning rather than a measurement.

So the production check is the test, and it is one command:

```sql
explain (analyze, buffers) select * from dashboard_rollup();
```

Want to see `Index Only Scan using idx_projects_rollup_wide`. If it says `Seq Scan`
and takes 8 s, the index is not being chosen and the honest next step is not a
third index — it is a small summary table maintained on write, because a
134-column, 492 MB table should not be scanned to answer this at all.

### Confirming it worked

The dashboard should paint in a second or two rather than hanging. Note the two
functions must also be **rewired to call the RPC** — the migration alone is inert.

---

## APPLIED 2026-08-18 — `20260818180000_source_stats_rollup.sql`

> **Outcome:** getSourceStats 75.8 s -> 1.4 s, 26 sources and 109,552 records unchanged.
> The two `test:mcp` failures it caused are gone — the suite is green.

**The last whole-table walk.** `getSourceStats` reads all 109,552 rows to produce
about 25 — measured at 75.8 s and 97.3 s. It is the slowest read in the app, it
powers the `list_sources` MCP tool, and it is why the last two `npm run test:mcp`
checks fail against their 60-second ceiling.

Same fix as the other two aggregates, and the least risky of the three: there is no
derived state here, just a count, a sum and a max.

| Adds | Why |
|---|---|
| `source_stats()` | one row per source instead of 109,552 |
| `idx_projects_source_stats` | ~5 MB, so the aggregate is an index-only scan rather than a 492 MB seq scan |

### One thing deliberately left in TypeScript

The function returns a raw **sum and count**, not an average, and the caller keeps
dividing. That is not an oversight. `getSourceStats` computes its average as
`sum += Number(population_percentage) || 0` over **every** row — a null completeness
counts as zero and still divides by the row. SQL `avg()` skips nulls instead, which
is arguably more correct and is definitely a **different number**. Changing a
dashboard figure while claiming to make it faster is how a performance fix becomes a
data bug. If that definition should change, it should change on purpose, in one
place.

### On adding a second index

This is a separate index rather than widening `idx_projects_rollup_wide`, because
Postgres cannot add columns to an existing index — widening means dropping and
rebuilding it, which is a full rebuild on a 492 MB table under a write lock, during
which the dashboard loses the index it now depends on. Three columns are not worth
that.

It does mean a second index maintained on every upsert while the nightly ingest is
still fighting write timeouts. Small — a narrow btree against the four GIN indexes
over jsonb that `20260813120000` dropped to relieve exactly that — but real.

Paste into the Supabase SQL editor:

```
supabase/migrations/20260818180000_source_stats_rollup.sql
```

`create index if not exists` and `create or replace function`, so re-running is
safe. Build it when the nightly ingest is not running.

### Confirming it worked

```bash
npm run test:mcp
```

The last two failures should pass. The numbers must not move: **26 sources,
109,552 records total**. A faster figure that is also a different figure is a bug,
not a win — and the null-completeness note above is exactly where that would show up.

---

## APPLIED 2026-08-18 — `20260818200000_kpi_snapshots.sql`

> **Outcome:** the team KPI row reads from a snapshot in 0.2 s instead of 35-46 s,
> and the card carries "as of HH:MM" so stored figures are never shown as live.

**The last slow thing on the dashboard.** After the rollups landed, `getKpiSummary`
became the slowest read by a wide margin — and the KPI row sits at the *top* of the
page, so it is what somebody watches a skeleton for.

Measured today:

| View | Rows | Time |
|---|---|---|
| team, 7 days | 21,426 | 6.9 s |
| team, 30 days | 109,552 | **45.9 s** |
| team, 90 days | 109,552 | 19.5 s |
| **one seller, 30 days** | **30** | **1.3 s** |

That last row is the whole design. A seller's own numbers are already fast, because
the `owner_user_id` filter cuts 109,552 rows to 30. This was never a general
performance problem — it is **three values**: the team view at each window the
dashboard offers. So they are computed once and stored.

### Why a snapshot and not a SQL aggregate

The other three fixes pushed the arithmetic into SQL. This one deliberately does not.
The code behind this summary derives a funnel position, a furthest-stage-reached
fan-out, an SLA breach against wall-clock `now`, contact-latency percentiles and three
breakdowns — logic whose failure mode is a *plausible wrong number*, not an error.
`lib/kpi.ts` already carries the scar of exactly that: every KPI on the dashboard was
once silently a random 72% sample.

Re-expressing that in SQL would mean two definitions of the funnel, in two languages,
obliged to agree forever. A snapshot avoids the duplication entirely, because the thing
that fills it **is** the existing TypeScript. There is no second implementation to drift.

### The cost is freshness, and the cards say so

These figures become as recent as the last refresh rather than live. Two mitigations:

- The cron refreshes all three windows on both scheduled runs (06:00 and 14:20).
- The summary carries `computed_at`, and the card subtitle now reads
  **"Last 30 days · 109,552 records · as of 14:20"** — a clock time today, a date once
  it is older, so a two-day-old snapshot cannot read as this afternoon.

A twelve-hour freshness window sits inside that cadence, so an inline rebuild is the
exception rather than most mornings. Per-seller views are never cached; at 1.3 s they
gain nothing but staleness.

Paste into the Supabase SQL editor:

```
supabase/migrations/20260818200000_kpi_snapshots.sql
```

### Verified working

Against the live database, once the table existed:

```
refreshKpiSnapshots([7])   ->  Refreshed 7d in 28.5s
getKpiSummary({days:7})    ->  0.2 s, total 21,426, as of 18:54
same call computed live    ->  9.9 s, total 21,426
```

Identical figures, 50x faster. Nothing breaks before the migration: the read misses,
the summary is computed inline exactly as before, and the write fails quietly — a slow
dashboard rather than a broken one.
