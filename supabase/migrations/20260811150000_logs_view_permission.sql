-- ============================================================================
-- 20260811150000_logs_view_permission
-- ----------------------------------------------------------------------------
-- Give the activity log a permission that actually exists in this workspace.
--
-- `logs.view` was added to the code — to the Permission type, the catalogue, the
-- path guard and the built-in role matrix — and the page still redirected its
-- author to the dashboard. The built-in matrix is only the FALLBACK for a
-- workspace whose app_roles table is missing. This workspace has the table, so
-- the stored arrays are authoritative, and they were seeded with seventeen
-- permissions before this one existed.
--
-- `admin` is no longer fixed here. roleStore now recomputes it from
-- KNOWN_PERMISSIONS on every read, because "admin holds everything the code
-- enforces" is an invariant rather than a list, and a migration per permission
-- works once and is forgotten the next time. This migration is for the roles
-- where the stored value genuinely is the decision.
--
-- sales_manager gets it because the person who notices a job has stopped is the
-- one running the team, not whoever happens to hold the admin role. The sellers
-- do not: the log records which filters colleagues applied, and that is
-- team-visible management information rather than something a BDR needs.
-- ============================================================================

-- The catalogue row, so the permission has a readable label in the role editor.
-- getPermissionCatalog already unions the code's list with this table, so the
-- permission was assignable without it — but it would have shown as a bare slug.
insert into public.app_permissions (name, label, description, is_enforced)
values (
  'logs.view',
  'Read the activity log',
  'See failures, slow reads and the filters colleagues applied. Read-only.',
  -- True because a check ships with this migration: /control/logs is guarded by
  -- it. getPermissionCatalog recomputes this flag from the code on every read
  -- anyway, so the stored value is a convenience rather than the authority.
  true
)
on conflict (name) do update
  set label = excluded.label,
      description = excluded.description,
      is_enforced = excluded.is_enforced;

-- `permissions` is text[], not jsonb — so array_append and the array containment
-- operator, not `||` with a JSON literal and `?`. Appended rather than assigned,
-- so anything else granted to this role since the seed survives, and the guard
-- makes it safe to run twice.
update public.app_roles
   set permissions = array_append(permissions, 'logs.view')
 where name = 'sales_manager'
   and not (permissions @> array['logs.view']);
