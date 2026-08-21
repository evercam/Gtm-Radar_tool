-- capital_markets → capital_projects
--
-- "Capital Markets" named a finance desk, not anything anyone here sells to. The
-- 4,269 records carrying it are SEC EDGAR filings disclosing facility or capex
-- intent — a company saying it means to build something — so "Capital Projects"
-- is both the standard construction term and an accurate description of the
-- record. CAPM was worse than merely vague: in finance it reads as the Capital
-- Asset Pricing Model.
--
-- WHY THIS IS A MIGRATION AND NOT AN UPDATE
--
-- `vertical` is a STORED generated column, as are `ref_code` (which embeds the
-- vertical CODE) and `org_path` (which embeds the vertical NAME). None can be
-- written directly. Replacing the function changes what NEW rows compute and
-- leaves every existing row holding its old value, so the rename needs a second
-- step that forces the 4,269 affected rows to recompute.
--
-- WHY IT IS SAFE TO CHANGE ref_code NOW AND WOULD NOT BE LATER
--
-- ref_code is a stable business id, and this rewrites 4,269 of them. Checked
-- before committing: of these records, zero are assigned, zero have been
-- enriched, and zero have been exported to Apollo. No ref_code in this vertical
-- has ever left the system, so nothing external is holding one. That stops being
-- true the first time one of these ships.
--
-- The hash component is derived from source_key|source_unique_id, so uniqueness
-- does not depend on the prefix and no collision is possible from this change.

-- ---- the classification functions, with only the filing branch changed ------

create or replace function public.lead_vertical(bt text, pt text, rt text)
returns text immutable language sql as $$
  select case
    when lower(coalesce(bt, pt, '')) like '%data cent%'                                             then 'data_center'
    when lower(coalesce(bt, pt, '')) like '%semiconduct%' or lower(coalesce(bt, pt, '')) like '%fab%' then 'semiconductor'
    when lower(coalesce(bt, pt, '')) like '%batter%' or lower(coalesce(bt, pt, '')) like '%gigafact%' then 'battery'
    when lower(coalesce(bt, pt, '')) like '%solar%'                                                 then 'solar'
    when lower(coalesce(bt, pt, '')) like '%wind%'                                                  then 'wind'
    when lower(coalesce(bt, pt, '')) like '%nuclear%'                                               then 'nuclear'
    when lower(coalesce(bt, pt, '')) like '%hydro%'                                                 then 'hydro'
    when lower(coalesce(bt, pt, '')) like '%bioenerg%' or lower(coalesce(bt, pt, '')) like '%biomass%'
      or lower(coalesce(bt, pt, '')) like '%biogas%'                                                then 'bioenergy'
    when lower(coalesce(bt, pt, '')) like '%pipeline%'                                              then 'pipeline'
    when lower(coalesce(bt, pt, '')) like '%coal%'                                                  then 'coal'
    when lower(coalesce(bt, pt, '')) like '%oil%' or lower(coalesce(bt, pt, '')) like '%gas%'
      or lower(coalesce(bt, pt, '')) like '%lng%'                                                   then 'oil_gas'
    when lower(coalesce(bt, pt, '')) like '%mine%' or lower(coalesce(bt, pt, '')) like '%mining%'   then 'mining'
    when lower(coalesce(bt, pt, '')) like '%steel%'                                                 then 'steel'
    when lower(coalesce(bt, pt, '')) like '%cement%'                                                then 'cement'
    when lower(coalesce(bt, pt, '')) like '%chemical%'                                              then 'chemicals'
    when lower(coalesce(bt, pt, '')) like '%pharmaceutic%' or lower(coalesce(bt, pt, '')) like '%biotech%'
      or lower(coalesce(bt, pt, '')) like '%life science%'                                          then 'pharma'
    when lower(coalesce(bt, pt, '')) like '%power generation%' or lower(coalesce(bt, pt, '')) like '%power plant%'
      or lower(coalesce(bt, pt, '')) like '%geotherm%'                                              then 'power'
    when lower(coalesce(bt, pt, '')) like '%stadium%' or lower(coalesce(bt, pt, '')) like '%arena%'  then 'construction'
    when rt = 'tender' then 'procurement'
    when rt = 'permit' then 'construction'
    when rt = 'news'   then 'market_intel'
    when rt = 'filing' then 'capital_projects'
    else 'other'
  end
$$;

create or replace function public.lead_vertical_code(v text)
returns text immutable language sql as $$
  select case v
    when 'data_center'     then 'DCTR' when 'semiconductor' then 'SEMI' when 'battery'      then 'BATT'
    when 'solar'           then 'SOLR' when 'wind'          then 'WIND' when 'nuclear'      then 'NUCL'
    when 'hydro'           then 'HYDR' when 'pipeline'      then 'PIPE' when 'coal'         then 'COAL'
    when 'oil_gas'         then 'OLGS' when 'mining'        then 'MINE' when 'steel'        then 'STEL'
    when 'cement'          then 'CMNT' when 'chemicals'     then 'CHEM' when 'procurement'  then 'PROC'
    when 'construction'    then 'CNST' when 'market_intel'  then 'MINT' when 'capital_projects' then 'CAPX'
    when 'bioenergy'       then 'BIOE' when 'pharma'        then 'PHRM' when 'power'        then 'POWR'
    else 'OTHR'
  end
$$;

-- ---- force the existing rows to recompute -----------------------------------
--
-- A generated column is recalculated on any UPDATE of the row, so touching a
-- column with its own value is enough. `record_type` is chosen because it is one
-- of the three inputs to lead_vertical and is never null on these rows.
--
-- ONE STATEMENT, AND THE REASON IS A BUG THIS FILE ALREADY CAUSED
--
-- The first version of this batched the update in a DO loop with `commit` between
-- chunks, to avoid holding locks while a cron writes. That works under psql, which
-- runs in autocommit — and psql is exactly how scripts/test-migrations.sh runs it,
-- so it passed. The Supabase SQL editor wraps a script in an explicit transaction,
-- where COMMIT inside plpgsql raises `invalid transaction termination` and rolls
-- back the whole file, the two functions included. Run against production it
-- changed nothing and looked like it had.
--
-- So: no procedural code, no transaction control, nothing that behaves
-- differently depending on how the file is fed to Postgres. 4,269 rows is a small
-- update; the timeout it was guarding against is handled by raising the limit for
-- this statement instead, which is honest about the cost rather than hiding it
-- behind machinery that does not survive the editor.
--
-- Re-runnable: the WHERE clause matches only rows still holding the old value, so
-- a second run finds nothing and does nothing.

set statement_timeout = '600s';

update public.canonical_projects p
   set record_type = p.record_type
 where p.vertical = 'capital_markets';

reset statement_timeout;
