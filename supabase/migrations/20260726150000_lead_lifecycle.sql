-- ============================================================================
-- 20260726150000_lead_lifecycle
-- ----------------------------------------------------------------------------
-- One lifecycle column, contact-channel validation, call-prep output, and the
-- audit trail — plus the composite indexes the scoped queries actually use.
--
-- Mirrors src/lib/lifecycle.ts. Any change to the status vocabulary must be
-- made in BOTH files: the check constraint here and LEAD_STATUSES there.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Lifecycle
-- ----------------------------------------------------------------------------
alter table public.canonical_projects
  add column if not exists status text not null default 'RAW'
    check (status in (
      'RAW', 'PENDING_ENRICHMENT', 'ENRICHING', 'ENRICHED',
      'PREPARED', 'ASSIGNED', 'CONTACTED', 'CONVERTED', 'LOST'
    )),

  -- one timestamp per transition, so the record's own history is queryable
  -- without unpacking the JSONB trail
  add column if not exists queued_at timestamptz,
  add column if not exists enrichment_started_at timestamptz,
  add column if not exists prepared_at timestamptz,
  add column if not exists contacted_at timestamptz,
  add column if not exists converted_at timestamptz,
  add column if not exists lost_at timestamptz,
  add column if not exists lost_reason text;

-- ----------------------------------------------------------------------------
-- Backfill from the retired processing_status
-- ----------------------------------------------------------------------------
-- `scored` and `routed` describe pipeline mechanics, not enrichment progress —
-- a scored record has still had nothing spent on it, so it maps to RAW.
-- `failed` and `duplicate` map to LOST because neither will ever be worked.
--
-- Guarded so re-running the migration never clobbers real progress: only rows
-- still sitting at the default RAW are touched.
update public.canonical_projects
set status = case processing_status
  when 'enriching'  then 'ENRICHING'
  when 'enriched'   then 'ENRICHED'
  when 'qualified'  then 'ASSIGNED'
  when 'failed'     then 'LOST'
  when 'duplicate'  then 'LOST'
  else 'RAW'
end
where status = 'RAW'
  and processing_status is not null
  and processing_status not in ('ingested', 'normalized', 'scored', 'routed');

-- A record that already carries an owner is at least ASSIGNED.
--
-- `owner_user_id` is added by 20260726130000_auth_rbac. This migration does
-- not require that one, so the backfill is guarded rather than assumed: run
-- the two in either order and both still work. Without the guard, applying
-- this file first fails with `column "owner_user_id" does not exist`.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'canonical_projects'
      and column_name = 'owner_user_id'
  ) then
    execute $sql$
      update public.canonical_projects
      set status = 'ASSIGNED'
      where owner_user_id is not null
        and status in ('RAW', 'ENRICHED', 'PREPARED')
    $sql$;
  end if;
end $$;

comment on column public.canonical_projects.processing_status is
  'DEPRECATED — superseded by `status` (see lib/lifecycle.ts). Retained for one release; nothing should write to it.';

-- ----------------------------------------------------------------------------
-- Contact validation
-- ----------------------------------------------------------------------------
-- Act Now needs a phone, Nurture needs an email. Confidence and source are
-- recorded so a basic regex/MX check is never mistaken for a verified one.
alter table public.canonical_projects
  add column if not exists phone_verified boolean not null default false,
  add column if not exists phone_confidence numeric(3,2) not null default 0,
  add column if not exists phone_type text,                  -- mobile | landline | voip
  add column if not exists phone_validation_source text,     -- twilio | basic

  add column if not exists email_verified boolean not null default false,
  add column if not exists email_confidence numeric(3,2) not null default 0,
  add column if not exists email_role_based boolean not null default false,  -- info@, sales@…
  add column if not exists email_domain_exists boolean not null default false,
  add column if not exists email_validation_source text;     -- hunter | zerobounce | basic

-- ----------------------------------------------------------------------------
-- Enrichment outcome
-- ----------------------------------------------------------------------------
alter table public.canonical_projects
  add column if not exists enrichment_source text,
  add column if not exists enrichment_completeness numeric(3,2),
  add column if not exists enrichment_errors text[],
  add column if not exists last_enrichment_attempt timestamptz,
  add column if not exists enrichment_retry_count integer not null default 0,
  -- append-only audit trail: one entry per action, newest last
  add column if not exists enrichment_history jsonb not null default '[]'::jsonb;

-- ----------------------------------------------------------------------------
-- Call preparation (generated by Claude once a record reaches ENRICHED)
-- ----------------------------------------------------------------------------
alter table public.canonical_projects
  add column if not exists call_prep_summary text,
  add column if not exists call_prep_insights jsonb,
  add column if not exists call_prep_generated_at timestamptz,
  add column if not exists call_prep_version text;

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
-- Every lead read filters by the caller's scope and orders by priority. These
-- cover the three shapes the app actually issues; without them each one is a
-- sequential scan over the whole table.

-- the scoped working list: "my BU + vertical, still open, best first"
create index if not exists idx_projects_scope_status
  on public.canonical_projects (bu, vertical, status, priority_score desc nulls last);

-- the enrichment queue: "queued or raw, best first"
create index if not exists idx_projects_status_priority
  on public.canonical_projects (status, priority_score desc nulls last);

-- an owner's own list
create index if not exists idx_projects_owner_status
  on public.canonical_projects (owner_user_id, status, priority_score desc nulls last);

-- recency, for the activity feed and daily-cap counting
create index if not exists idx_projects_status_created
  on public.canonical_projects (status, created_at desc);

-- partial index for the "needs a channel" checks — small and hot
create index if not exists idx_projects_unverified_contact
  on public.canonical_projects (status)
  where phone_verified = false or email_verified = false;
