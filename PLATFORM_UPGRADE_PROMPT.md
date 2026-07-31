# Platform Upgrade Prompt — Sales Intelligence & Lead Enrichment

Paste everything below the divider into a fresh Claude Code session opened in
`C:\Users\dell\Desktop\ldr_tool`.

This supersedes `UI_REVAMP_PROMPT.md` (the UI work is folded in as Phase 0–1).
It is written against the **actual state of this codebase**, verified on
2026-07-26 — including several things that are broken or missing today. Read
the "Ground truth" section before planning anything.

---

# PART I — GROUND TRUTH

## What already exists (do not rebuild)

This is **not** a greenfield project. Roughly 12,500 lines of working
TypeScript already implement a large part of the target architecture under
different names. Your job is to **upgrade and rename**, not to start over.

| Target concept | Already built as | File |
|---|---|---|
| Search APIs / ingestion connectors | 23 live source adapters | `src/lib/adapters/*` |
| Lead scoring (ICP, 0–100, bands) | Priority engine, P1–P4 | `src/lib/priority.ts` |
| Attribution rules engine | Routing engine (route + stage) | `src/lib/routing.ts` |
| Admin-configurable rules in DB | Policy loader with fallbacks | `src/lib/policies.ts` |
| Enrichment (Apollo + Claude + GLEIF) | Single-record + batch runner | `src/lib/enrich/run.ts`, `src/app/api/enrich/batch/route.ts` |
| Enrichment queue + quotas | Queue query, daily cap, concurrency | `src/lib/queries.ts`, `src/lib/enrich/policy.ts` |
| Enrichment run history | `enrichment_runs` table | `supabase/migrations/20260726110000_*.sql` |
| Per-field provenance / audit | Provenance planner | `src/lib/provenance.ts` |
| Key-account rubric | Weighted scoring | `src/lib/keyaccount.ts` |
| Control center (partial) | `/enrichment`, `/routing`, `/settings` | `src/app/*` |

The 23 adapters are the "Search APIs" of the spec: Glenigan, Barbour ABI,
ConstructConnect, SAM.gov, SEC EDGAR, TED, Find a Tender, AusTender, Contracts
Finder, World Bank, USASpending, Planning.ie, NYC/Chicago permits, 8 RSS news
feeds, and GEM energy trackers. **Do not replace them with Clearbit/Hunter.**
The spec's examples are generic; this product's sources are construction,
procurement, permits, filings and energy.

## What is broken or missing RIGHT NOW — verify before you build

Verified against the live Supabase instance on 2026-07-26:

1. **`source_credentials` was referenced in 9 files but defined in no migration
   at all** — saving an API key from Settings silently failed against a
   PostgREST 404. Migration `20260726120000_source_credentials.sql` now creates
   it, with RLS enabled and no policy so only the service role can read it.
   *(Fixed — apply the migration.)*
2. **`source_registry` and `icp_definitions` are retired, not missing.**
   `sourceCatalog.ts` supersedes the registry and ICP data now lives on
   `canonical_projects.icp_code`. But `/settings` still queried the retired
   registry, so it rendered **zero credential forms** — no key could be saved
   from the UI at all. Settings now drives off `SOURCE_CATALOG`; the dead query
   functions and the orphaned `/icps/[code]` page are removed. **Do not
   recreate these tables.** *(Fixed.)*
3. **Three migrations are pending** — see `supabase/RUN_THESE.md` for the order
   and the verification commands. Until applied, `route`, `stage`,
   `priority_score`, `priority_band`, `scoring_policy`, `enrichment_policy`,
   `enrichment_runs` and `source_credentials` don't exist.
4. **Credentials are stored in plaintext.** `src/lib/actions/credentials.ts`
   writes `payload.api_key = apiKeyInput` with no encryption. This directly
   violates the AES-256-GCM requirement. *(Still open — Phase 2.)*
5. **There is no authentication whatsoever.** No users, no roles, no session,
   no RLS. Every page is public. *(Still open — Phase 1.)*
6. `canonical_projects` holds ~5,862 rows and is the only substantial table.
7. ~~`ANTHROPIC_API_KEY` is unset; Glenigan credentials resolve from env.~~
   *(Fixed — see Conflict 4. Every key now resolves only from the encrypted
   store. Verify with `npm run verify:secrets`.)*

---

# PART II — CONFLICTS TO RESOLVE BEFORE CODING

These are places where the specification contradicts the existing system. **Ask
the user to decide each one before writing code.** Do not guess — each changes
the data model or inverts existing logic.

Two smaller product decisions belong in the same conversation:

- **Auth scope for v1**: full Supabase Auth with email invites and the six-role
  matrix, or a simpler single shared admin gate to unblock the Control Center
  while the role model is designed? The answer changes Phase 1 substantially.
- **Leaderboard default**: on for everyone, or off until an Admin enables it?

### Conflict 1 — The BU / verticale / région axes (most important)

The spec treats these as three independent axes, with BU meaning a business
line (`Software`, `Retail`, `Healthcare`).

**This app already uses `bu` to mean geography**: `usa | uk | ireland | apac |
export` (see `src/lib/classify.ts`, the `bu` check constraint in
`supabase_setup.sql`, and every adapter). Its `vertical` is the sector
(`data_center`, `semiconductor`, `solar`, `nuclear`, `oil_gas`, …), and
geography detail lives in `country` / `state_province`.

So today: **`bu` ≈ the spec's `region`**, and there is **no business-line axis
at all**. Options:

- **(a)** Keep `bu` as geography and treat the spec's "BU" as the existing
  `vertical`. Cheapest, no migration, but the vocabulary stays confusing.
- **(b)** Add a true `business_unit` column, rename the current `bu` →
  `region`. Correct long-term, but touches all 23 adapters, the classifier,
  the generated `ref_code` / `org_path`, and every query.
- **(c)** Keep `bu` and add `region` as a separate, finer axis.

Recommend **(b)** if the org genuinely has business lines; **(a)** if "BU"
in the spec was just borrowed boilerplate. **Ask.**

### Conflict 2 — `leads` vs `canonical_projects`

The spec's SQL creates a `leads` table. This app has `canonical_projects` with
5,862 rows, ~60 columns, generated classification columns, and 23 adapters
writing to it.

**Do not create a second table.** Map the spec's columns onto
`canonical_projects` and add what's missing (`status`, `owner_user_id`,
`phone_verified`, `email_verified`, `call_prep_*`, `enrichment_history`, …).
Optionally expose a `leads` view for readability. Confirm this mapping approach
with the user.

### Conflict 3 — Apollo mandatory / Claude optional (inverts current code)

The spec: Apollo is **required**, Claude is **optional**.
The code: `src/lib/enrich/run.ts` returns early if Claude isn't configured, and
Claude runs *first* to identify the account that Apollo then enriches.

This is an architectural inversion, not a flag flip — Apollo needs a company
domain, and today Claude is what resolves it. Before inverting, decide how the
account/domain gets resolved when Claude is off (Apollo org search by name?
the record's existing `company_name_raw`?). **Ask.**

### Conflict 4 — "No environment variables except the DB connection" — RESOLVED

**Decision: honour the spec.** The database is now the only source for every
API key. Resolved 2026-07-30.

What changed:

- `adapters/credentials.ts` — `resolveCredentials(sourceKey, defaultBaseUrl)`
  reads the `source_credentials` row and nothing else. The env-var name
  parameters are gone from the signature and from all four adapter call sites.
  `baseUrl` falls back to the adapter's own `defaultBaseUrl` constant, not env.
- `adapters/credentialStatus.ts` — the `env` origin is gone; `origin` is now
  `'saved' | 'none'`. It reads the same row `resolveCredentials` does, so the
  two can no longer disagree and offer a source that then fails to authenticate.
- `crypto/store.ts` — `readSecret` no longer falls through to `process.env`.
  `getSecretStatuses` still *detects* env values and reports `origin: 'env'`,
  which is what drives the import prompt in Settings.
- `socrata-permits.ts` — was reading `process.env.SOCRATA_APP_TOKEN` directly,
  bypassing the store even though `socrata_app_token` is a registered secret.

The migration path (run it **before** deleting anything):

```bash
npm run import:secrets     # both stores: app_secrets + source_credentials
npm run verify:secrets     # proves nothing resolves from env any more
```

`importEnvSourceCredentials` is the per-source half — the sibling of the
existing `importEnvSecrets` — and the Settings "Import from env" button now runs
both. A source that already stores a key is skipped, never overwritten, so a
forgotten variable cannot clobber a rotated key.

**Deliberate exceptions**, none of which are vendor credentials:

| Variable | Why it cannot move |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DATABASE_URL` | the DB connection itself |
| `CRON_SECRET` | `/api/cron` must authenticate before any DB read |
| `CREDENTIALS_MASTER_KEY[_PREVIOUS]` | the root of trust for the ciphertext |
| `SESSION_SIGNING_KEY` | app-generated, never pasted; a stored key always wins, and without it `jwt.ts` cannot be tested without a live DB |
| `GEM_DATA_DIR`, `ENRICH_MODEL`, `CALL_PREP_MODEL`, `APOLLO_BASE_URL` | non-secret operational config |

There is no `apiConfig.ts` in this codebase — that part of the spec described a
file that does not exist.

### Conflict 5 — Scoring engines overlap

`src/lib/priority.ts` already scores 0–100 with configurable weights, bands and
a phase-timing table, stored in `scoring_policy`. The spec wants ICP scoring
with per-BU weights totalling 100% and Hot/Warm/Cold thresholds.

These are the same engine with different vocabulary. **Extend `priority.ts`
to be per-BU** (a policy row per BU rather than one global) and map
P1/P2 → Hot, P3 → Warm, P4 → Cold. Do not write a second scorer.

### Conflict 6 — Comment policy

The spec asks for code without superfluous comments. This codebase is
deliberately, densely commented, and those comments encode real domain
knowledge (why Glenigan filters client-side, what GEM statuses mean, which
vendor response shapes were confirmed live).

Apply the rule to **new** code. **Do not mass-strip existing explanatory
comments** — that destroys hard-won knowledge and is not what the rule is for.
Flag this to the user rather than silently deleting.

### Conflict 7 — Act Now / Nurture vs route / stage

The spec's channel model (Act Now → phone required, Nurture → email required)
maps onto the existing `route` (sales/marketing/partner/none) + `stage`
(act_now/qualify/nurture/hold/disqualify). `stage: act_now` and
`stage: nurture` already exist. Extend that vocabulary; don't add a parallel
one. Note the spec allows a lead to be **both** Act Now and Nurture — today
`stage` is single-valued, so this needs an additional flag or a channels array.

---

# PART III — WHAT TO BUILD

Read `AGENTS.md` first: **this is Next.js 16.2.11 and it differs from what you
may remember.** Read the relevant guide in `node_modules/next/dist/docs/`
before writing routing, layout, middleware, caching or server-action code.

## Transverse rules (apply to everything)

1. **Secrets** — no env vars but the DB connection. All API keys entered in
   Settings, encrypted at rest with **AES-256-GCM**, decrypted server-side only,
   rotatable without downtime. Never send a key or a mask to the client;
   `/api/credentials/status` returns booleans and must stay that way.
2. **Clean code and UI** — new code carries JSDoc/TSDoc on exported and
   critical functions only. UI copy is direct and functional; no filler. Prefer
   `<select>` / structured pickers over free-text inputs wherever the value set
   is known (BU, verticale, region, role, status, source, thresholds).
3. **Strict RBAC** — enforced at every layer: middleware, route handler, DB
   query, and UI. Check permissions before every action, never trust the layer
   above.
4. **Optimised DB access** — every lead read is an indexed, parameterised query
   filtering by BU + verticale + region + the caller's role scope, executed in
   Postgres. No over-fetching, no application-side filtering of large sets.
   **RLS policies on every table.** Note: `getRecords` in `src/lib/queries.ts`
   already demonstrates the tiered-degradation pattern — preserve it.
5. **Degrade, never blank** — a missing migration, table or key must render an
   explanation and the fix (`src/components/MigrationRequired.tsx` is the
   pattern). This is why the current broken state is invisible; keep the
   honesty, improve the visibility.

## Design system

- **Primary / navbar**: deep red `#D7263D`
- **Backgrounds**: `#F7F7F8` light / `#121214` dark
- **Text**: `#1A1A1A` light / `#F5F5F5` dark
- **Status**: green `#22C55E`, amber `#F59E0B`, red `#EF4444`, blue `#3B82F6`
- **Cards**: radius `12px`, shadow `0 4px 12px rgba(0,0,0,.06)`, hover
  `0 8px 24px rgba(0,0,0,.10)`
- **Type**: Inter variable
- **Light/dark toggle**, persisted to localStorage, defaulting to system

Define these as Tailwind v4 `@theme` tokens in `globals.css`. The codebase
currently hand-rolls `zinc`-based classes in every component and duplicates
colour maps across `SourceSearch.tsx`, `records/page.tsx`, `lib/format.ts` and
`lib/priority.ts` — collapse all of it into tokens plus primitives in
`src/components/ui/`: `Card`, `Badge`, `Button`, `Table`, `Drawer`, `Toast`,
`Stat`, `ScoreRing`, `Toggle`, `EmptyState`, `Skeleton`, `ProgressBar`.

Components: fixed red navbar (Dashboard, My Leads, Seeding, KPI, Profile +
notifications + avatar); contextual sidebar for Manager/Admin; animated
circular score ring; zebra-striped sortable tables with sticky filters and
virtualised pagination; custom SVG empty states; 200–300ms transitions,
skeleton loaders, tooltips, toasts; mobile-first with tables collapsing to
cards.

**Motion must respect `prefers-reduced-motion`** — every animation needs a
reduced variant that cuts to the end state. The highest-value animation is real
progress on long enrichment and scoring jobs (currently a static "Enriching…"
label for what can be minutes of work).

## Navigation and roles

Regular users (BDR/SDR/AE/Marketing) see **only**: Dashboard, My Leads,
Profile (+ KPI for Marketing). Everything else moves under `/control/*` with
permanent redirects from the old paths:

```
/control                 operator console (live state, not a link menu)
/control/search          ← /search
/control/enrichment      ← /enrichment
/control/routing         ← /routing        (attribution rules)
/control/sources         ← /sources
/control/seeding         ← /ingest, /ingest/gem
/control/import          ← /import
/control/settings        ← /settings
/control/users           new — user + role management
/control/kpi             new — KPI dashboard
```

**RBAC matrix** — implement exactly:

| Role | Data scope | Actions | Sections |
|---|---|---|---|
| BDR | assigned leads | view, mark handled, transfer | Dashboard, My Leads, Profile |
| SDR | assigned leads | view, qualify, transfer | Dashboard, My Leads, Profile |
| AE | qualified leads received | view, export, deal status | Dashboard, My Leads, Profile |
| Marketing | Nurture leads in scope | view, nurture, export | + KPI |
| Sales Manager | whole team | + reassign, edit BU scoring | + team view, aggregate stats, comparative KPI |
| Admin | everything | + users, roles, APIs, cron, rules | everything + Settings, Sources, Seeding, Logs |

Custom roles by duplication; role × action matrix editable by Admin. An Admin
must not be able to remove the last Admin role.

## Lifecycle

```
RAW → PENDING_ENRICHMENT → ENRICHING → ENRICHED → PREPARED → ASSIGNED
    → CONTACTED / CONVERTED / LOST
```

Add `status` to `canonical_projects` with a check constraint, plus timestamps
for each transition and an `enrichment_history` JSONB audit trail. The existing
`processing_status` column has overlapping values (`ingested`, `normalized`,
`enriching`, `enriched`, `scored`, `qualified`, `routed`, `failed`,
`duplicate`) — **reconcile the two into one**, don't run both.

## Core principle — enrich only what will be contacted

Never enrich speculatively. A daily 06:00 UTC job applies prioritisation rules
in priority order, filters RAW leads, respects per-rule and global daily
volumes, and marks the selection `PENDING_ENRICHMENT`. Weekly planning prepares
the following week's quotas with a 20% buffer. The existing
`enrichment_policy` (batch size, concurrency, daily cap, min score,
re-enrich window) is the foundation — extend it to per-BU rules with the JSON
rule shape from the spec (`conditions` / `volume` / `action`).

Channel requirements: Act Now needs a validated **phone**, Nurture needs a
validated **email**; a lead missing its required channel stays
`PENDING_ENRICHMENT`. Validation falls back to regex/MX when Twilio/Hunter
aren't configured.

## Feature areas

Build these in the order given in Part IV. Each is specified in the original
brief; the notes below are only where the existing code changes the approach.

- **Sources & APIs** — per-source encrypted key, monthly request cap, batch/cron
  vs realtime, schedule, endpoint/auth/rate-limit/timeout/mapping/dedupe.
  Toggle with status dot, last run, 24h errors, quota bar. "Test API & health"
  button already exists for 2 sources (`/api/ingest/[source]/test`) — extend to
  all 23. Health monitoring: uptime %, latency, error rate, incident history,
  alerts.
- **Seeding / ingestion** — visual schedule calendar, run history, real-time
  progress, per-source detail, filterable error logs, manual trigger.
  Deduplication already exists via the `(source_key, source_unique_id)` unique
  constraint — build on it, adding email/domain/name dedupe.
- **Scoring** — per-BU weight sliders totalling 100%, ICP and persona config per
  BU, Hot/Warm/Cold thresholds, audit trail, automatic recalculation, and a
  **test-before-save** preview. `getRoutingPreview` already implements exactly
  this dry-run pattern — reuse it.
- **Attribution** — `owner_user_id` nullable; unassigned when no rule matches;
  visual cascading rule builder; coverage count per rule; "unassigned leads"
  view; manual drag-and-drop reassignment for Managers; recalculation touches
  only untouched leads. Only leads with an owner are Apollo-eligible.
- **Call prep** — on `ENRICHED`, generate a 250–400 word structured brief via
  Claude (`company_summary`, `key_contact`, `business_context`,
  `suggested_angle`, `objections_anticipated`, `next_best_action`) → `PREPARED`.
  Claude integration already exists in `src/lib/enrich/claude.ts` with a
  profile system per source type — extend rather than duplicate.
- **Quota engine** — extraction requests with fixed or percentage splits across
  BU / verticale / region, strict enforcement, automatic re-run favouring leads
  with an email, progress bar, final alert on shortfall, saveable templates.
- **Apollo export** — daily batches of ≤100 via `POST /contacts/bulk_create`,
  configurable eligibility, `run_dedupe`, target list, field mapping, retry with
  backoff on 401/422/429/500, per-lead status (Created/Existing/Failed),
  timestamps, KPI. Manual validation before sequences (decision #10).
- **KPI dashboard** — enrichment volume/success/failure by source; Act Now
  waiting and SLA breaches; nurture progression; per BU/verticale/region;
  per account; per user. Combinable filters, CSV export, comparative admin view.
- **Profile & onboarding** — adaptive first-run flow (BU → verticale → regions →
  role) generating default quotas, batch size (100/day) and thresholds, with a
  summary screen. Profile shows personal stats, Hot/Warm/Cold ring, 7/30/90-day
  performance curve, activity timeline, and preferences (notification
  frequency, theme, FR/EN language, per-type email alerts).
- **Notifications** — real-time in-app, email digests, Slack for admins, SLA
  alerts, quota alerts at 80/90/100%.
- **Gamification** — light and professional, tied to real outcomes. This is an
  SDR tool: the mechanics must make the *right* work visible, never manufacture
  urgency. Queue burn-down against a target for Act Now leads still missing
  their required channel; daily streak on leads worked, computed server-side;
  a per-BU data-quality score derived from the existing completeness tiers,
  trending over time; milestones (first 100 enriched, first key account
  resolved, a band cleared to zero) surfacing as a toast plus a persistent
  profile badge. Leaderboard across users is **opt-in and disable-able by an
  Admin** in Settings — ask the user whether it defaults on. Store all of this
  in its own tables (`user_activity`, `achievements`); never denormalise it
  into `canonical_projects`.

---

# PART IV — EXECUTION ORDER

Work in vertical slices. A shipped, working slice beats nine half-migrated
pages. After each: `npx tsc --noEmit`, `npx eslint src`, and a click-through on
a running dev server — a green build proves nothing about an empty table.

**Phase 0 — Unblock and decide.**
Resolve the seven conflicts with the user. Write and apply the missing
migrations (`source_credentials` first — it has never existed), apply the two
pending ones, and confirm every table the code queries actually resolves.

**Phase 1 — Foundations.** Auth (Supabase Auth), `user_profiles`, RBAC across
middleware + handlers + RLS, design tokens, UI primitives, app shell with the
red navbar, `/control/*` route move with redirects, Profile v1.

**Phase 2 — Secrets.** AES-256-GCM encryption, Settings key entry, env-var
import migration, removal of env fallbacks, rotation without downtime.

**Phase 3 — Lifecycle & schema.** `status`, `owner_user_id`, validation and
call-prep columns, `enrichment_history`; reconcile with `processing_status`;
indexes on (BU, verticale, region, status, score, created_at).

**Phase 4 — Ingestion & seeding.** Per-source config and quotas, cron, dedupe,
`/control/seeding` with live progress and logs, health monitoring for all 23
adapters.

**Phase 5 — Prioritisation.** Per-BU enrichment rules, the 06:00 job, queue
with quotas, admin queue view with force/snooze, weekly planner.

**Phase 6 — Enrichment.** Apollo-mandatory inversion, channel-adaptive
phone/email flows, optional validators with regex/MX fallback, real-time
progress.

**Phase 7 — Scoring & call prep.** Per-BU weights and thresholds, score ring,
Claude brief generation → `PREPARED`.

**Phase 8 — Distribution.** Attribution engine, "My Leads" with filters and
SLA alerts, transfer flows, manager team view and reassignment.

**Phase 9 — Apollo export & KPI.** Daily bulk export with retry and
traceability, KPI dashboard, CSV export.

**Phase 10 — Polish.** Notifications, gamification tables and surfaces, WCAG
2.1 AA, caching and index tuning, OpenAPI docs.

---

# PART V — DEFINITION OF DONE

- `npx tsc --noEmit` and `npx eslint src` clean (`IE_COUNCILS` in
  `SourceSearch.tsx` is a known pre-existing warning — fix it in passing).
- `npm run build` succeeds and every route renders in a running dev server.
- Every role verified by clicking through as that role, light and dark.
- No secret reaches the client — grep the network payloads to confirm.
- RLS verified by querying with the anon key directly and confirming a
  non-owner cannot read another user's leads.
- Every quota and cap enforced server-side; the UI can narrow a selection but
  never widen it past policy.
- No feature silently blanks on a missing migration.
