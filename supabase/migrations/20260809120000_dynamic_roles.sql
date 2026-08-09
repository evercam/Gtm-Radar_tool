-- Roles become data.
--
-- They were a CHECK constraint listing six strings and a matrix in
-- src/lib/auth/roles.ts, so adding a role meant a migration, a code change and a
-- deploy. This moves the ROLES and their permission bundles into tables an admin
-- can edit, while leaving the permission CHECKS themselves in code — see below.
--
-- Nothing about the existing six changes. They are seeded here with exactly the
-- permissions they already had, and marked is_system so they cannot be deleted:
-- losing 'admin' would lock everyone out of user management with no way back
-- short of a SQL console.

create table if not exists app_permissions (
  name text primary key,
  label text not null,
  description text not null default '',
  /*
    Whether any code actually reads this permission.

    An admin may invent a permission, and it will appear in the UI and can be
    ticked onto a role — but nothing enforces a name the codebase does not check,
    so it grants precisely nothing until a developer ships a check for it. This
    column is what lets the UI say so out loud instead of presenting a role that
    looks powerful and is not.

    Maintained by the app from its own compile-time list, not by hand.
  */
  is_enforced boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists app_roles (
  name text primary key,
  label text not null,
  description text not null default '',
  permissions text[] not null default '{}',
  /* Built-in roles: editable, but never deletable. */
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The permissions the code enforces today. is_enforced is true for every one of
-- them because each has a real call site; anything an admin adds later defaults
-- to false until the app says otherwise.
insert into app_permissions (name, label, description, is_enforced) values
  ('leads.view.own',     'View own leads',        'See leads assigned to you', true),
  ('leads.view.all',     'View all leads',        'See every lead regardless of owner', true),
  ('leads.qualify',      'Qualify leads',         'Move a lead through qualification', true),
  ('leads.transfer',     'Transfer leads',        'Hand a lead to someone else', true),
  ('leads.reassign',     'Reassign leads',        'Reassign anyone''s leads; manage the roster', true),
  ('leads.export',       'Export leads',          'Send leads to Apollo and read export history', true),
  ('kpi.view',           'View own KPIs',         'See your own numbers', true),
  ('kpi.view.team',      'View team KPIs',        'See the whole team''s numbers', true),
  ('control.access',     'Open Control Center',   'Reach the operations pages', true),
  ('sources.run',        'Run source searches',   'Search and inspect sources', true),
  ('sources.ingest',     'Ingest from sources',   'Write source records into the pipeline', true),
  ('enrichment.run',     'Run enrichment',        'Spend credits enriching records', true),
  ('scoring.edit',       'Edit scoring',          'Change the scoring policy', true),
  ('routing.edit',       'Edit routing',          'Change routing and assignment rules', true),
  ('settings.manage',    'Manage settings',       'Edit policies and app settings', true),
  ('credentials.manage', 'Manage credentials',    'Add and rotate API keys', true),
  ('users.manage',       'Manage users',          'Change roles, scope and access', true)
on conflict (name) do update
  set label = excluded.label,
      description = excluded.description,
      is_enforced = excluded.is_enforced;

-- The six existing roles, with exactly the permissions they hold today.
insert into app_roles (name, label, description, permissions, is_system) values
  ('bdr', 'BDR', 'Works assigned leads — view, mark handled, transfer',
    array['leads.view.own','leads.transfer','kpi.view'], true),
  ('sdr', 'SDR', 'Works assigned leads — view, qualify, transfer',
    array['leads.view.own','leads.transfer','kpi.view','leads.qualify'], true),
  ('ae', 'Account Executive', 'Receives qualified leads — view, export, deal status',
    array['leads.view.own','leads.transfer','kpi.view','leads.export'], true),
  ('marketing', 'Marketing', 'Works nurture leads — view, nurture, export',
    array['leads.view.own','leads.transfer','kpi.view','leads.export','kpi.view.team'], true),
  ('sales_manager', 'Sales Manager', 'Whole team — reassignment and BU scoring',
    array['leads.view.own','leads.view.all','leads.qualify','leads.transfer','leads.reassign',
          'leads.export','kpi.view','kpi.view.team','control.access','sources.run',
          'enrichment.run','scoring.edit','routing.edit'], true),
  ('admin', 'Admin', 'Everything, plus users, keys, rules and cron',
    array['leads.view.own','leads.view.all','leads.qualify','leads.transfer','leads.reassign',
          'leads.export','kpi.view','kpi.view.team','control.access','sources.run',
          'sources.ingest','enrichment.run','scoring.edit','routing.edit','settings.manage',
          'credentials.manage','users.manage'], true)
on conflict (name) do nothing;   -- never overwrite a workspace's own edits

/*
  Replace the CHECK with a foreign key.

  The CHECK hard-coded the same six names, so a role created in app_roles could
  never actually be assigned to anybody. ON UPDATE CASCADE lets a role be
  renamed without orphaning its users; ON DELETE RESTRICT means a role still in
  use cannot be dropped out from under them.
*/
alter table user_profiles drop constraint if exists user_profiles_role_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_profiles_role_fkey'
  ) then
    -- Any row pointing at a role that no longer exists would block the FK.
    -- There should be none, but a workspace that hand-edited a role would.
    update user_profiles
       set role = 'bdr'
     where role is not null
       and role not in (select name from app_roles);

    alter table user_profiles
      add constraint user_profiles_role_fkey
      foreign key (role) references app_roles(name)
      on update cascade on delete restrict;
  end if;
end $$;

alter table app_roles enable row level security;
alter table app_permissions enable row level security;

-- Readable by any signed-in user: the sidebar and every page need to know what
-- the caller may do. Writes go through the service role behind a users.manage
-- check in the route, exactly like user_profiles.
drop policy if exists app_roles_read on app_roles;
create policy app_roles_read on app_roles for select to authenticated using (true);

drop policy if exists app_permissions_read on app_permissions;
create policy app_permissions_read on app_permissions for select to authenticated using (true);

create index if not exists idx_user_profiles_role on user_profiles(role);
