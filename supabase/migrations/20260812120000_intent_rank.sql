-- ============================================================================
-- 20260812120000_intent_rank
-- ----------------------------------------------------------------------------
-- Sort by intent: how ready this lead is to be called, rather than how big it is.
--
-- `priority_score` ranks by VALUE — contract size, capacity, ICP fit, key account.
-- It answers "is this worth winning", and a large owner scores well on it whether
-- or not anything is happening right now. So the top of a priority-sorted list is
-- not the top of a call list, and a rep working down it spends their morning on
-- the biggest project rather than the readiest one.
--
-- Intent is the other axis: the brief's timing verdict, the routing stage, and
-- whether a specific trigger event was found. All three are already stored, so
-- this is a GENERATED column — Postgres maintains it on every write and it cannot
-- drift from an application that forgot to recompute it. That matters here: the
-- arrival verdict and the signal score both read the admin-editable phase table
-- and therefore CANNOT be expressed this way, which is why they are computed in
-- code instead. Intent can, so it is.
--
-- Lower is more ready, so a plain ascending sort is the call list.
--
--   0  reach_now AND a named trigger  — something happened, and it is the moment
--   1  reach_now                      — the moment, no specific event found
--   2  stage act_now                  — routing says urgent
--   3  a named trigger, any timing    — something happened, timing unclear
--   4  watch                          — real, not yet
--   5  everything else, unjudged
--   6  too_early                      — will come back
--   7  too_late                       — cold, and blocked from export anyway
--
-- `too_early` sits below unjudged deliberately. An unjudged lead might be ready
-- and nobody has looked; a too_early one has been looked at and is not.
-- ============================================================================

alter table canonical_projects
  add column if not exists intent_rank smallint
  generated always as (
    case
      when evercam_timing = 'too_late' then 7
      when evercam_timing = 'too_early' then 6
      when evercam_timing = 'reach_now' and nullif(btrim(coalesce(trigger_event, '')), '') is not null then 0
      when evercam_timing = 'reach_now' then 1
      when stage = 'act_now' then 2
      when nullif(btrim(coalesce(trigger_event, '')), '') is not null then 3
      when evercam_timing = 'watch' then 4
      else 5
    end
  ) stored;

-- Ordered reads land on the index, and the tie-break is priority — within the
-- same readiness, the bigger project first, which is the order a rep expects.
create index if not exists idx_projects_intent_rank
  on canonical_projects (intent_rank, priority_score desc nulls last);
