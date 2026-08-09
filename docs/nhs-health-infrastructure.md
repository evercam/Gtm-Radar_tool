# NHS health-infrastructure leads

Pulls NHS and other health-body **construction** contracts out of the two keyless
UK procurement feeds the tool already had — Find a Tender and Contracts Finder —
and lands them in `canonical_projects`.

```bash
npm run ingest:nhs -- --dry        # see what would land, write nothing
npm run ingest:nhs                 # 180-day lookback, both publishers
npm run ingest:nhs -- --days=365 --source=contracts-finder
```

Re-running is safe. `canonical_projects` is unique on
`(source_key, source_unique_id)`, so a second run updates rather than duplicates —
which matters, because a notice is republished as it moves from tender to award.

## Why this needed its own filter

Two things about NHS procurement break the generic construction scoping.

**"NHS" is in the buyer's name, not the title.** Of 13 NHS notices in a sample of
100, only 3 said NHS anywhere in the title or description. The adapter's `keyword`
filter reads only tender text, so searching it for "NHS" misses roughly three
quarters of them. Scoping by organisation has to read `parties[]`.

**The generic construction vocabulary is wrong in both directions here.** It
admits `Microsoft Infrastructure Software Licensing`, `Enterprise Network
Infrastructure` and `Legal Services - Property & Construction` on the words
*infrastructure* and *construction*, while having no entry that would catch
`DBTH Asbestos Abatement` or `Ward 6B South Refurbishment Works`.

CPV classification codes would settle it, except they are barely published:
measured over 500 releases each on 2026-08-07, **Find a Tender carried a CPV code
on 4% of notices and Contracts Finder on 0%**. There is nothing to lean on but the
words, so `src/lib/healthInfra.ts` uses a purpose-built vocabulary where
exclusions are tested first and win.

`healthInfraOnly` therefore **replaces** `constructionOnly` rather than narrowing
it — running both would discard the very notices it exists to find.

## What counts as construction

Kept — something is physically built, altered or removed:

`new_build` · `refurbishment` · `demolition` · `building_services` · `fabric`

Set aside by default — real estates spend, but not construction:

`survey_design` (condition surveys, feasibility studies, planning applications,
design-team and cost-consultancy appointments) · `maintenance` (backlog and
planned maintenance programmes)

These are still classified and labelled, just filtered out; pass
`{ includeAdvisory: true }` to `classifyHealthInfra` to keep them. They are worth
revisiting as early warning — a condition survey today is a refurbishment next
year — but they are not a construction queue.

Advisory rules are tested **before** the trades, because an appointment to advise
names the trade it concerns: `M&E Engineer Led Design Team` and `Consultancy
Service For Flat Roof Replacement` otherwise read as M&E and roofing work.

## Two operational facts

**The publishers throttle at 12 requests per 120 seconds.** Undocumented — measured.
`fetchWithRetry` honours `Retry-After` only up to 30s, so a publisher asking for
120 burns all three attempts and fails the run. The OCDS adapter therefore paces
itself at one page per 10s (`minRequestIntervalMs`), which costs nothing on a
one-page scheduled pull and is what makes a backfill possible at all. Budget about
four minutes per thousand notices read.

**`maxRecords` bounds notices read, not notices kept.** Health estates work is
roughly 0.2% of the stream, and Find a Tender alone published over 2,100 notices
in June 2026 against the adapter's 40-page ceiling. So the script walks the window
in 30-day slices, each of which fits inside that ceiling with headroom. Widening
`--slice` much past a month risks silently reading only part of it.

## Known gap: there is no `healthcare` vertical

These land with `vertical = 'procurement'`, like every other tender. Adding a
healthcare vertical means changing `leadVertical()` **and** the SQL that mirrors it,
and `vertical` feeds the generated `ref_code` column — so it would rewrite the
business id of existing rows, not just new ones. Worth doing deliberately, not as
a side effect of an ingest.

Until then `building_type` carries the work kind (`Healthcare — refurbishment`,
`Healthcare — demolition / enabling works`, …), which is sortable in the queue.

One warning if you edit those labels: `leadVertical` matches loose substrings, and
the natural label for the fabric category — "building **fab**ric" — hits the
semiconductor test and files hospital cladding as a chip plant. It is called
"external envelope" for that reason, and `scripts/test-health-infra.mjs` asserts
every label still resolves to `procurement`.
