-- ============================================================================
-- 20260803100000_repair_stale_enriched_status
-- ----------------------------------------------------------------------------
-- Backfills the status of records that were enriched while the transition was
-- broken.
--
-- `transitionLead` was called with a jump straight from RAW to ENRICHED, which
-- `canTransition` correctly refused; nothing read the return value, so every
-- record ever enriched kept whatever status it already had. The writer is fixed
-- (it now walks PENDING_ENRICHMENT -> ENRICHING -> ENRICHED one legal step at a
-- time), but the records enriched before that fix still carry `enriched_at`
-- alongside a status of RAW or PENDING_ENRICHMENT.
--
-- It is not cosmetic: those rows are indistinguishable from unenriched stock, so
-- the queue offers to pay for them again, and the journey panel showed 380 leads
-- as raw material that had in fact already been through the whole pipeline.
--
-- `enriched_at` is the evidence and the status is what is wrong, never the other
-- way round — the timestamp is only ever written next to a successful pass.
-- ============================================================================

-- A record deliberately re-queued AFTER enrichment (a staleness refresh) has
-- `queued_at` later than `enriched_at`, and is genuinely waiting on a worker.
-- Repairing those would cancel a real re-enrichment, so they are left alone.
update public.canonical_projects
set status = 'ENRICHED',
    enrichment_started_at = coalesce(enrichment_started_at, last_enrichment_attempt, enriched_at),
    queued_at = coalesce(queued_at, enriched_at)
where enriched_at is not null
  and status in ('RAW', 'PENDING_ENRICHMENT')
  and (queued_at is null or queued_at <= enriched_at);

-- An owner outranks ENRICHED: `assignmentStore` can set `owner_user_id` without
-- a status transition, so these rows are further along than they claim.
update public.canonical_projects
set status = 'ASSIGNED',
    owner_assigned_at = coalesce(owner_assigned_at, enriched_at)
where owner_user_id is not null
  and enriched_at is not null
  and status in ('RAW', 'PENDING_ENRICHMENT', 'ENRICHED');

-- Handover is terminal here, and `apollo_exported_at` is the archive flag, so a
-- successfully exported record cannot still be sitting in the queue.
update public.canonical_projects
set status = 'ASSIGNED'
where apollo_exported_at is not null
  and status in ('RAW', 'PENDING_ENRICHMENT');
