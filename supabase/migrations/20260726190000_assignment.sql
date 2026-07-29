-- ============================================================================
-- 20260726190000_assignment
-- ----------------------------------------------------------------------------
-- Lead distribution: who owns a lead, when they were given it, and whether
-- they have acted within the SLA.
--
--   assignment_rules   admin-editable rule list (conditions -> user or role)
--   assignment_history append-only record of every ownership change, so a
--                      reassignment is auditable rather than destructive
--   SLA columns        the deadline a lead must be actioned by, and the
--                      outcome once it is
-- ============================================================================

create table if not exists public.assignment_rules (
  id text primary key default 'default',
  rules jsonb not null default '[]'::jsonb,   -- shape: lib/assignment.ts AssignmentRule[]
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_assignment_rules_updated_at on public.assignment_rules;
create trigger trg_assignment_rules_updated_at
  before update on public.assignment_rules
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Ownership history
-- ----------------------------------------------------------------------------
-- Overwriting owner_user_id loses who had it before and why it moved, which is
-- exactly what a manager needs when a lead goes cold. Every change appends.
create table if not exists public.assignment_history (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  from_user_id uuid,
  to_user_id uuid,
  rule_id text,
  reason text,
  changed_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_assignment_history_lead
  on public.assignment_history (lead_id, created_at desc);

-- ----------------------------------------------------------------------------
-- SLA
-- ----------------------------------------------------------------------------
-- The deadline is stamped at assignment from the routing rule's sla_hours, so
-- a change to the policy never retroactively breaches leads already in flight.
alter table public.canonical_projects
  add column if not exists sla_due_at timestamptz,
  add column if not exists sla_breached boolean not null default false,
  add column if not exists first_contact_at timestamptz,
  add column if not exists last_action_at timestamptz,
  add column if not exists action_count integer not null default 0;

-- The "what needs attention now" query: an owner's open leads by deadline.
create index if not exists idx_projects_sla
  on public.canonical_projects (owner_user_id, sla_due_at)
  where sla_due_at is not null and status not in ('CONVERTED', 'LOST');

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.assignment_rules enable row level security;
alter table public.assignment_history enable row level security;

drop policy if exists assignment_rules_select on public.assignment_rules;
create policy assignment_rules_select on public.assignment_rules
  for select to authenticated using (true);

-- History is visible for leads you can already see. Managers and admins see
-- everything via can_see_all_leads(); everyone else sees their own trail.
drop policy if exists assignment_history_select on public.assignment_history;
create policy assignment_history_select on public.assignment_history
  for select to authenticated
  using (
    public.can_see_all_leads()
    or from_user_id = auth.uid()
    or to_user_id = auth.uid()
  );
