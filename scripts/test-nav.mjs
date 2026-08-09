/**
 * Navigation integrity — against the REAL src/lib/nav.ts.
 *
 * The sidebar keys its links by href, so a duplicated entry surfaces only as a
 * React console warning about non-unique keys — nothing fails, nothing looks
 * broken, and the second copy renders anyway. That is exactly the kind of
 * mistake a careless edit makes and nobody notices, so it is asserted here
 * rather than left to be spotted in a browser.
 *
 *   node --experimental-transform-types scripts/test-nav.mjs
 */

import { NAV_SECTIONS, CONTROL_TABS, ADMIN_TABS } from '../src/lib/nav.ts';
import { permissionForPath, ROUTE_PERMISSIONS, ROLE_PERMISSIONS, can } from '../src/lib/auth/roles.ts';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const group = (n) => console.log(`\n${n}`);

const dupes = (arr) => arr.filter((v, i) => arr.indexOf(v) !== i);
const allItems = NAV_SECTIONS.flatMap((s) => s.items);

group('Every href is unique — the sidebar keys on it');
{
  const d = dupes(allItems.map((i) => i.href));
  check('no duplicate href across the sidebar', d.length === 0, d.join(', '));
  const dt = dupes(CONTROL_TABS.map((i) => i.href));
  check('no duplicate href in the Operations tabs', dt.length === 0, dt.join(', '));
  const da = dupes(ADMIN_TABS.map((i) => i.href));
  check('no duplicate href in the Administration tabs', da.length === 0, da.join(', '));
}

group('Every entry is complete');
for (const [name, list] of [['sidebar', allItems], ['control tabs', CONTROL_TABS], ['admin tabs', ADMIN_TABS]]) {
  check(`${name}: every item has a label`, list.every((i) => typeof i.label === 'string' && i.label.trim().length > 0));
  // Lucide icons are forwardRef objects, not plain functions.
  check(`${name}: every item has a renderable icon`, list.every((i) => {
    const t = typeof i.icon;
    return i.icon != null && (t === 'function' || t === 'object');
  }));
  check(`${name}: every href is absolute`, list.every((i) => i.href.startsWith('/')), list.map((i) => i.href).filter((h) => !h.startsWith('/')).join(', '));
  check(`${name}: no trailing slash`, list.every((i) => i.href === '/' || !i.href.endsWith('/')));
}

group('Labels do not collide inside a section');
for (const s of NAV_SECTIONS) {
  const d = dupes(s.items.map((i) => i.label));
  check(`${s.title}: labels are distinct`, d.length === 0, d.join(', '));
}

group('The rail lands on a page that carries its section tabs');
// The rail names each operator section ONCE and the tab strip names the pages
// inside it, so these are deliberately no longer mirrors — asserting that every
// tab has a rail entry would just re-demand the duplication that was removed.
//
// What still has to hold is reachability: whatever the rail points at must be a
// page in that section's strip. If it is not, the strip never renders there and
// every other page in the section is orphaned — nothing errors, the links simply
// cease to exist for anyone who did not bookmark them.
for (const [section, tabs] of [
  ['Operations', CONTROL_TABS],
  ['Administration', ADMIN_TABS],
]) {
  const sidebarHrefs = [...new Set((NAV_SECTIONS.find((s) => s.title === section)?.items ?? []).map((i) => i.href))];
  const tabHrefs = new Set(tabs.map((i) => i.href));
  const missingFromTabs = sidebarHrefs.filter((h) => !tabHrefs.has(h));

  check(`${section}: the rail entry is one of the tabs`, missingFromTabs.length === 0, missingFromTabs.join(', '));
  check(`${section}: the rail names the section once`, sidebarHrefs.length === 1, `${sidebarHrefs.length} entries`);
  // Every page in the section must be a tab, or it is reachable from nowhere.
  check(`${section}: the strip covers more than the landing page`, tabHrefs.size > 1, `${tabHrefs.size} tab(s)`);
}

group('A page is not offered from two different areas');
{
  const bySection = NAV_SECTIONS.map((s) => [s.title, s.items.map((i) => i.href)]);
  const seen = new Map();
  const straddling = [];
  for (const [title, hrefs] of bySection) {
    for (const h of hrefs) {
      if (seen.has(h) && seen.get(h) !== title) straddling.push(`${h} (${seen.get(h)} + ${title})`);
      seen.set(h, title);
    }
  }
  check('no page appears in two sections', straddling.length === 0, straddling.join(', '));
}

group('Permissions are named, not invented');
{
  const KNOWN = new Set([
    'leads.view.own', 'leads.view.all', 'leads.qualify', 'leads.transfer', 'leads.reassign', 'leads.export',
    'kpi.view', 'kpi.view.team', 'control.access', 'sources.run', 'sources.ingest', 'enrichment.run',
    'scoring.edit', 'routing.edit', 'settings.manage', 'credentials.manage', 'users.manage',
  ]);
  const used = [...allItems, ...CONTROL_TABS, ...ADMIN_TABS].map((i) => i.permission).filter(Boolean);
  const unknown = used.filter((p) => !KNOWN.has(p));
  check('every permission referenced exists', unknown.length === 0, unknown.join(', '));
}

group('The Work section stays open to everyone');
{
  const work = NAV_SECTIONS.find((s) => s.title === 'Work')?.items ?? [];
  check('Work has items', work.length > 0);
  check('Work needs no permission', work.every((i) => !i.permission), work.filter((i) => i.permission).map((i) => i.label).join(', '));
}

group('Route guards resolve to the most specific prefix');
{
  /*
    /admin/costs sits below /admin in ROUTE_PERMISSIONS, so a first-match lookup
    returned control.access and the entry's own enrichment.run requirement was
    dead code. Nothing was exposed — every role holding control.access also held
    enrichment.run — but that is a coincidence of the current matrix, not a
    guarantee, and it ends the moment roles are defined in the database.
  */
  check(
    '/admin/costs keeps its own requirement',
    permissionForPath('/admin/costs') === 'enrichment.run',
    String(permissionForPath('/admin/costs'))
  );
  check('/admin/settings is not shadowed by /admin', permissionForPath('/admin/settings') === 'settings.manage');
  check('/admin itself still needs control.access', permissionForPath('/admin') === 'control.access');
  check('/control/enrichment keeps its own requirement', permissionForPath('/control/enrichment') === 'enrichment.run');
  check('/control falls back to control.access', permissionForPath('/control') === 'control.access');
  check('an unguarded path is null', permissionForPath('/records') === null);
  // A prefix must end at a segment boundary, or /controlpanel would be guarded.
  check('a prefix must end at a segment', permissionForPath('/controlpanel') === null);

  /*
    Holders, not role names. can() takes a resolved permission bundle now that
    roles are database rows — passing a name silently denied everything before
    can() was made to fail closed, and threw after.
  */
  const holders = Object.values(ROLE_PERMISSIONS).map((permissions) => ({ permissions }));
  for (const item of [...CONTROL_TABS, ...ADMIN_TABS]) {
    const need = permissionForPath(item.href);
    if (!need) continue;
    check(`${item.href} is reachable by some role`, holders.some((h) => can(h, need)), `needs ${need}`);
  }

  // Every tab's own declared permission must be at least as strong as the route
  // guard, or the sidebar offers a link the page then refuses.
  for (const item of [...CONTROL_TABS, ...ADMIN_TABS]) {
    const need = permissionForPath(item.href);
    if (!need || !item.permission) continue;
    const shown = holders.filter((h) => can(h, item.permission));
    check(
      `${item.href} is not offered to anyone the page rejects`,
      shown.every((h) => can(h, need)),
      `shows for ${item.permission}, page needs ${need}`
    );
  }
  check('every guarded prefix names a permission', ROUTE_PERMISSIONS.every((r) => Boolean(r.permission)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
