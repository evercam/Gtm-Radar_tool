-- Phase, filterable in the database.
--
-- `search_projects` could not filter on phase honestly. The mapping from 117 raw
-- source spellings to 11 canonical phases lives in TypeScript, so the tool fetched
-- the top `limit * 40` rows by score, folded them, and returned what matched —
-- which meant every project in the requested phase below that score cutoff was
-- invisible, and a short result read as a small total. Asking for "Operating"
-- returned zero and looked like an answer.
--
-- So the mapping moves into a generated column the planner can index. The function
-- body below is GENERATED from src/lib/phase.ts by scripts/generate-phase-sql.mjs
-- and must not be hand-edited — scripts/test-phase-parity.mjs asserts the two
-- agree on every distinct value in the table, so a stale copy fails loudly.


/*
  The same normalisation lib/phase.ts performs, so a phase filter can be a WHERE
  clause against an index instead of a two-thousand-row scan folded in TypeScript.

  IMMUTABLE is required rather than decorative: the generated column below cannot
  exist without it. It is honestly immutable — the mapping is baked into the body,
  so the only way it changes is a migration that rewrites this function.

  The exact CASE returns early, before the rules run, and the rules stay in
  DECLARATION ORDER. Both matter: /^shelved/ has to win before the generic
  application pattern would claim it, exactly as in TypeScript.
*/
CREATE OR REPLACE FUNCTION normalise_phase(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  k text;
  hit text;
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN NULL;
  END IF;

  k := lower(regexp_replace(btrim(raw), '\s+', ' ', 'g'));

  hit := CASE k
    WHEN 'proposed' THEN 'Planned'
    WHEN 'announced' THEN 'Planned'
    WHEN 'discovered' THEN 'Planned'
    WHEN 'in-development' THEN 'Planned'
    WHEN 'pre-permit' THEN 'Permitting'
    WHEN 'pre-construction' THEN 'Pre-construction'
    WHEN 'construction' THEN 'Under construction'
    WHEN 'operating' THEN 'Operating'
    WHEN 'operating pre-retirement' THEN 'Operating'
    WHEN 'retired' THEN 'Retired'
    WHEN 'mothballed' THEN 'On hold'
    WHEN 'shelved' THEN 'On hold'
    WHEN 'idle' THEN 'On hold'
    WHEN 'idled' THEN 'On hold'
    WHEN 'cancelled' THEN 'Cancelled'
    WHEN 'permitting' THEN 'Permitting'
    WHEN 'under construction' THEN 'Under construction'
    WHEN 'commissioning' THEN 'Under construction'
    WHEN 'on hold' THEN 'On hold'
    WHEN 'tender' THEN 'Tendering'
    WHEN 'awarded' THEN 'Awarded'
    WHEN 'contract awarded' THEN 'Awarded'
    WHEN 'in process' THEN 'Permitting'
    WHEN 'issued' THEN 'Approved'
    WHEN 're-issued' THEN 'Approved'
    WHEN 'early planning' THEN 'Planned'
    WHEN 'plans approved' THEN 'Approved'
    WHEN 'pipeline' THEN 'Planned'
    WHEN 'active' THEN 'Under construction'
    WHEN 'closed' THEN 'Operating'
    WHEN 'dropped' THEN 'Cancelled'
    WHEN 'announcement' THEN 'Planned'
    WHEN 'pre backfill phase' THEN 'Under construction'
    WHEN 'pre board phase' THEN 'Under construction'
    WHEN 'issued permit' THEN 'Approved'
    WHEN 'completed' THEN 'Operating'
    WHEN 'hold' THEN 'On hold'
    WHEN 'refused' THEN 'Cancelled'
    WHEN 'pending plans review' THEN 'Permitting'
    WHEN 'pending plans review assignment' THEN 'Permitting'
    WHEN 'new' THEN 'Planned'
    WHEN 'scoping' THEN 'Planned'
    WHEN 'awaiting consents' THEN 'Permitting'
    WHEN 'consents approved' THEN 'Approved'
    WHEN 'under construction/commissioning' THEN 'Under construction'
    WHEN 'built' THEN 'Operating'
    WHEN 'final grant' THEN 'Approved'
    WHEN 'final grant review' THEN 'Approved'
    WHEN 'decision issued' THEN 'Approved'
    WHEN 'decision notice issued' THEN 'Approved'
    WHEN 'decision made' THEN 'Approved'
    WHEN 'application finalised' THEN 'Approved'
    WHEN 'withdrawn' THEN 'Cancelled'
    WHEN 'application withdrawn' THEN 'Cancelled'
    WHEN 'appealed' THEN 'Permitting'
    WHEN 'appealed financial' THEN 'Permitting'
    WHEN 'decision appealed' THEN 'Permitting'
    WHEN 'application under appeal' THEN 'Permitting'
    WHEN 'further information' THEN 'Permitting'
    WHEN 'valid' THEN 'Permitting'
    WHEN 'n/a' THEN 'Planned'
    ELSE NULL
  END;
  IF hit IS NOT NULL THEN
    RETURN hit;
  END IF;

  -- Fallback patterns, in declaration order. First match wins, as in TypeScript.
  IF k ~ '^shelved' THEN RETURN 'On hold'; END IF;
  IF k ~ '^idle' THEN RETURN 'On hold'; END IF;
  IF k ~ 'invalid.*(case closed)' THEN RETURN 'Cancelled'; END IF;
  IF k ~ '^(incompleted|unregistered)' THEN RETURN 'Permitting'; END IF;
  IF k ~ 'invalid' THEN RETURN 'Permitting'; END IF;
  IF k ~ 'withdraw' THEN RETURN 'Cancelled'; END IF;
  IF k ~ 'cancel' THEN RETURN 'Cancelled'; END IF;
  IF k ~ '(applica|assessment|validat|referral|recommend|registrat|registered|planner|officer|appeal|\yai\y|cai|sai|consultee|publication|pre-reg|decision|report|comments|prepare|approval|review|request|received|requested|notice)' THEN RETURN 'Permitting'; END IF;
  IF k ~ '(grant|approved|permit)' THEN RETURN 'Approved'; END IF;
  IF k ~ 'construct' THEN RETURN 'Under construction'; END IF;

  -- Unmapped stays NULL and visible, rather than guessed into the nearest bucket.
  RETURN NULL;
END;
$$;

/*
  Stored, not virtual.

  A VIRTUAL generated column would re-evaluate the function per row per query and
  could not be indexed, which is the entire point. STORED costs one text column
  and is written once at insert/update.
*/
/*
  Added only if absent, rather than dropped and re-added.

  The column was already present on the live database when this migration was
  written — applied out-of-band, with no migration file recording it — and it
  already agreed with phase.ts on all 143 raw values in the table. A
  DROP + ADD would have rewritten a 109k-row table under an ACCESS EXCLUSIVE lock
  to arrive at the column that was already there, and broken every reader for the
  duration. So the column is left alone if it exists.

  CREATE OR REPLACE above still refreshes the FUNCTION, which is the part that has
  to track phase.ts — and because the column is GENERATED ALWAYS from it, a
  replaced function is picked up without touching the column definition.
*/
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'canonical_projects' AND column_name = 'phase_normalised'
  ) THEN
    ALTER TABLE canonical_projects
      ADD COLUMN phase_normalised text
      GENERATED ALWAYS AS (normalise_phase(current_phase)) STORED;
  END IF;
END
$$;

/*
  The filter is almost always phase AND something else, and it is ordered by score.
  Leading with phase and carrying priority_score lets the same index satisfy the
  predicate and the sort, so the common query neither scans nor sorts.
*/
CREATE INDEX IF NOT EXISTS canonical_projects_phase_normalised_idx
  ON canonical_projects (phase_normalised, priority_score DESC NULLS LAST, id);

/*
  Free-text search, kept flat as the table grows. Separate from phase, same tool.

  `gtm_search_projects(query:)` runs ILIKE '%…%' across two columns. A LEADING
  wildcard cannot use a btree, so this is a sequential scan of every row —
  currently ~400-800ms for a term that matches nothing, and linear in the table
  size from here. Trigram indexes are the only thing that helps a leading wildcard.

  HONEST PROVENANCE: this was first written up as a fix for a measured 9.5s
  statement timeout. That measurement is not trustworthy — it was taken while
  another session was adding the STORED generated column above, which holds an
  ACCESS EXCLUSIVE lock, so the query was almost certainly queued behind DDL
  rather than scanning slowly. Re-measured on fresh terms afterwards it is
  sub-second. These indexes are therefore a defensible improvement on a real
  scan, NOT a fix for an outage — treat them as optional, and weigh the GIN
  write overhead on a table this size before applying.
*/
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS canonical_projects_canonical_name_trgm_idx
  ON canonical_projects USING gin (canonical_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS canonical_projects_company_name_raw_trgm_idx
  ON canonical_projects USING gin (company_name_raw gin_trgm_ops);
