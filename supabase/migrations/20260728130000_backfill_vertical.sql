-- ============================================================================
-- 20260728130000_backfill_vertical
-- ----------------------------------------------------------------------------
-- Recomputes `vertical`, `vertical_code`, `ref_code` and `org_path` for rows
-- classified before the previous migration widened lead_vertical().
--
-- WHY THIS IS NEEDED — and why the previous migration was not enough on its
-- own. `vertical` is declared `generated always as (…) STORED`, so Postgres
-- evaluates the expression at INSERT/UPDATE time and writes the result to
-- disk. Replacing the function changes what NEW and UPDATED rows get; it does
-- not revisit rows already written. So after 20260728120000 the function
-- returned 'bioenergy' while 755 existing rows still read 'other'.
--
-- An UPDATE is what forces re-evaluation. Assigning a column to itself is a
-- no-op for the data and a full re-evaluation for every generated column on
-- the row, which is exactly what is wanted here.
--
-- Every row is touched, not only the 'other' ones: 'biogas' contains 'gas',
-- so those records currently classify as oil_gas and belong under bioenergy
-- now that it exists. Limiting the backfill to 'other' would leave them
-- misfiled with nothing to indicate it.
--
-- `updated_at` is deliberately preserved. A trigger maintains it, so a plain
-- UPDATE would restamp all 6,080 rows to today and destroy the "how fresh is
-- this record" signal that scoring's freshness component reads.
-- ============================================================================

do $$
declare
  moved bigint;
begin
  -- Suspend the updated_at trigger for the duration: this is a reclassification,
  -- not a change anyone made to the record.
  alter table public.canonical_projects disable trigger trg_canonical_projects_updated_at;

  update public.canonical_projects
  set building_type = building_type;

  get diagnostics moved = row_count;

  alter table public.canonical_projects enable trigger trg_canonical_projects_updated_at;

  raise notice 'Reclassified % rows.', moved;
end $$;
