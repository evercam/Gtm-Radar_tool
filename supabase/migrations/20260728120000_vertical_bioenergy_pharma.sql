-- ============================================================================
-- 20260728120000_vertical_bioenergy_pharma
-- ----------------------------------------------------------------------------
-- Three source categories had no bucket in lead_vertical(), so 755 records —
-- 12% of the table — classified as 'other' and were invisible to any vertical
-- filter, including the enrichment policy's:
--
--   681  Global Bioenergy Power Tracker   (GEM bioenergy plants)
--    22  Pharmaceutical / Biotech
--     6  Stadium / Arena
--
-- Bioenergy is the significant one: an entire GEM tracker was landing in the
-- catch-all. It gets its own vertical rather than being folded into another,
-- because it is a distinct asset class with its own owners.
--
-- Pharma likewise: a biotech plant is a cleanroom build, not general
-- construction, and the buyers differ. Stadiums are ordinary construction and
-- are treated as such.
--
-- `vertical` and `ref_code` are generated columns, so every affected row is
-- reclassified by Postgres the moment these functions change — no backfill,
-- but note that ref_code changes for those rows too (…-OTHR-… becomes
-- …-BIOE-…). Nothing keys on ref_code; it is a human-readable label.
-- ============================================================================

create or replace function public.lead_vertical(bt text, pt text, rt text)
returns text immutable language sql as $$
  select case
    when lower(coalesce(bt, pt, '')) like '%data cent%'                                             then 'data_center'
    when lower(coalesce(bt, pt, '')) like '%semiconduct%' or lower(coalesce(bt, pt, '')) like '%fab%' then 'semiconductor'
    when lower(coalesce(bt, pt, '')) like '%batter%'     or lower(coalesce(bt, pt, '')) like '%gigafact%' then 'battery'
    when lower(coalesce(bt, pt, '')) like '%solar%'                                                 then 'solar'
    when lower(coalesce(bt, pt, '')) like '%wind%'                                                  then 'wind'
    when lower(coalesce(bt, pt, '')) like '%nuclear%'                                               then 'nuclear'
    when lower(coalesce(bt, pt, '')) like '%hydro%'                                                 then 'hydro'
    -- Bioenergy before the generic power test below, so "Global Bioenergy
    -- Power Tracker" is read as bioenergy rather than as unclassified power.
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
    -- Cleanroom builds: different buyers and requirements to general construction.
    when lower(coalesce(bt, pt, '')) like '%pharmaceutic%' or lower(coalesce(bt, pt, '')) like '%biotech%'
      or lower(coalesce(bt, pt, '')) like '%life science%'                                          then 'pharma'
    -- Generic generation, only after every specific fuel above has had its turn.
    when lower(coalesce(bt, pt, '')) like '%power generation%' or lower(coalesce(bt, pt, '')) like '%power plant%'
      or lower(coalesce(bt, pt, '')) like '%geotherm%'                                              then 'power'
    -- Stadiums, arenas and the rest are ordinary construction.
    when lower(coalesce(bt, pt, '')) like '%stadium%' or lower(coalesce(bt, pt, '')) like '%arena%'  then 'construction'
    when rt = 'tender' then 'procurement'
    when rt = 'permit' then 'construction'
    when rt = 'news'   then 'market_intel'
    when rt = 'filing' then 'capital_markets'
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
    when 'construction'    then 'CNST' when 'market_intel'  then 'MINT' when 'capital_markets' then 'CAPM'
    when 'bioenergy'       then 'BIOE' when 'pharma'        then 'PHRM' when 'power'        then 'POWR'
    else 'OTHR'
  end
$$;
