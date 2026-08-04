-- ============================================================================
-- 20260804090000_export_field_policy
-- ----------------------------------------------------------------------------
-- Which Apollo custom field each of our fields is written into.
--
-- This was a hardcoded list in lib/export/apolloFields.ts (FIELD_MAP), matched
-- by NAME against whatever the workspace happens to have defined. That is fine
-- until a name no longer resolves to something writable, and two of the seven
-- already do not:
--
--   Qualify Account            modality 'account' — cannot be set on a contact
--   evercam_us_project_signal  modality 'account' — cannot be set on a contact
--
-- Apollo accepts both into the payload and silently discards them, so the ICP
-- score, trigger event and pain point were "sent" on every export and never
-- arrived. Re-pointing them at a contact-level field is a configuration change,
-- not a code change — a workspace can rename or rebuild a custom field at any
-- time, and a deploy is the wrong unit of work for that.
--
-- Empty config means the built-in defaults are in force, exactly like the other
-- policy tables.
-- ============================================================================

create table if not exists public.export_field_policy (
  id text primary key default 'default',
  config jsonb not null default '{}'::jsonb,   -- shape: lib/export/fieldPolicy.ts ExportFieldPolicy
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_export_field_policy_updated_at on public.export_field_policy;
create trigger trg_export_field_policy_updated_at
  before update on public.export_field_policy
  for each row execute function public.set_updated_at();

-- Same posture as the other policy tables: any signed-in user may read it (the
-- pages that render it are permission-gated), and only the service role writes.
do $$
begin
  if to_regclass('public.export_field_policy') is not null then
    execute 'alter table public.export_field_policy enable row level security';
    execute 'drop policy if exists export_field_policy_select on public.export_field_policy';
    execute 'create policy export_field_policy_select on public.export_field_policy for select to authenticated using (true)';
  end if;
end $$;
