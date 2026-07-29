-- ============================================================================
-- 20260726090000_routing_policy
-- ----------------------------------------------------------------------------
-- Admin-defined routing/disposition rules (single row). The app falls back to
-- built-in defaults when this is empty, so it works before this is populated.
-- ============================================================================

create table if not exists public.routing_policy (
  id text primary key default 'default',
  rules jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_routing_policy_updated_at on public.routing_policy;
create trigger trg_routing_policy_updated_at
  before update on public.routing_policy
  for each row execute function public.set_updated_at();
