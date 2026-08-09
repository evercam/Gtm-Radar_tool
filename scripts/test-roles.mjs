/**
 * Roles as data, permissions as code.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-roles.mjs
 *
 * The split this file defends: an admin may invent a ROLE, because a role is a
 * named bundle of checks that already exist. An admin may also invent a
 * PERMISSION, and it will grant nothing — because nothing reads a name the
 * codebase does not check. The second half is the dangerous one, so the
 * assertions here are mostly about it being reported rather than hidden.
 *
 * Pure — no network, no database. The store's DB paths are covered by the
 * migration test; what is checked here is the pure matrix and the resolution
 * rules that decide whether somebody gets in.
 */

import {
  can,
  isKnownPermission,
  isRole,
  KNOWN_PERMISSIONS,
  BUILT_IN_ROLE_PERMISSIONS,
  PERMISSION_LABELS,
  permissionForPath,
  ROUTE_PERMISSIONS,
} from '@/lib/auth/roles';

let passed = 0,
  failed = 0;
const check = (n, c, d) => {
  if (c) {
    passed++;
    console.log(`  PASS ${n}`);
  } else {
    failed++;
    console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`);
  }
};

console.log('can() reads a resolved bundle, not a role name');
{
  const user = { permissions: ['leads.view.own', 'kpi.view'] };
  check('a held permission passes', can(user, 'leads.view.own'));
  check('an unheld one does not', !can(user, 'settings.manage'));
  check('no user is not permitted', !can(null, 'kpi.view'));
  check('undefined is not permitted', !can(undefined, 'kpi.view'));
  check('an empty bundle grants nothing', !can({ permissions: [] }, 'kpi.view'));
  /*
    The whole reason can() takes a bundle: roles are database rows, so resolving
    one is I/O. Resolving once when the session loads keeps twenty call sites in
    pages and route handlers synchronous.
  */
  check('a custom role works exactly like a built-in', can({ permissions: ['routing.edit'] }, 'routing.edit'));
}

console.log('\nThe built-ins are unchanged');
{
  const built = BUILT_IN_ROLE_PERMISSIONS;
  check('six built-in roles', Object.keys(built).length === 6, Object.keys(built).join(', '));
  check('admin holds every known permission', KNOWN_PERMISSIONS.every((p) => built.admin.includes(p)));
  check('bdr cannot manage users', !built.bdr.includes('users.manage'));
  check('bdr cannot see all leads', !built.bdr.includes('leads.view.all'));
  check('sales_manager can reassign', built.sales_manager.includes('leads.reassign'));
  check('sales_manager cannot manage settings', !built.sales_manager.includes('settings.manage'));
  check('ae can export', built.ae.includes('leads.export'));
  check('marketing sees team KPIs', built.marketing.includes('kpi.view.team'));

  // Every built-in bundle must reference only permissions the code enforces —
  // a built-in role with an inert permission would be shipping the very thing
  // this design warns admins about.
  for (const [name, perms] of Object.entries(built)) {
    check(`${name} holds only enforced permissions`, perms.every(isKnownPermission), perms.filter((p) => !isKnownPermission(p)).join(', '));
  }
}

console.log('\nA permission the code does not check is reported, not hidden');
{
  check('a real permission is known', isKnownPermission('routing.edit'));
  check('an invented one is not', !isKnownPermission('exports.approve'));
  check('a typo is not silently accepted', !isKnownPermission('routing.editt'));
  check('a non-string is not', !isKnownPermission(42));

  /*
    This is the honest part of "custom permissions". can() will happily return
    true for an invented name, because the bundle contains it — but no code path
    ever asks for that name, so nothing changes. The UI must therefore label it,
    and isKnownPermission is what lets it.
  */
  const holder = { permissions: ['exports.approve'] };
  check('can() still returns true for an invented name', can(holder, 'exports.approve'));
  check('but the name is flagged as unenforced', !isKnownPermission('exports.approve'));
  check('and it grants none of the real capabilities', KNOWN_PERMISSIONS.every((p) => !can(holder, p)));
}

console.log('\nEvery known permission is presentable');
{
  for (const p of KNOWN_PERMISSIONS) {
    check(`${p} has a label`, Boolean(PERMISSION_LABELS[p]), 'missing from PERMISSION_LABELS');
  }
  check('no duplicate permissions', new Set(KNOWN_PERMISSIONS).size === KNOWN_PERMISSIONS.length);
}

console.log('\nRole names are no longer a closed set');
{
  check('a built-in name is a role', isRole('admin'));
  check('an invented name is a role', isRole('nhs_desk'));
  check('empty is not', !isRole(''));
  check('whitespace is not', !isRole('   '));
  check('a non-string is not', !isRole(null));
}

console.log('\nRoute guards still resolve most-specific-first');
{
  check('/admin/costs keeps its own requirement', permissionForPath('/admin/costs') === 'enrichment.run');
  check('/control/exports is not the /control catch-all', permissionForPath('/control/exports') === 'leads.export');
  check('/control falls back', permissionForPath('/control') === 'control.access');
  check('an unguarded path is null', permissionForPath('/records') === null);
  check(
    'every guarded route names an enforced permission',
    ROUTE_PERMISSIONS.every((r) => isKnownPermission(r.permission)),
    ROUTE_PERMISSIONS.filter((r) => !isKnownPermission(r.permission)).map((r) => r.prefix).join(', ')
  );

  /*
    A role that cannot reach /control cannot reach anything inside it, whatever
    its own bundle says — the proxy checks the deepest match only. So a role
    given routing.edit but not control.access can open /control/routing directly.
    Asserted so the behaviour is deliberate rather than discovered.
  */
  const routingOnly = { permissions: ['routing.edit'] };
  check('a narrow custom role reaches its own page', can(routingOnly, permissionForPath('/control/routing')));
  check('and is refused the Control Center landing page', !can(routingOnly, permissionForPath('/control')));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
