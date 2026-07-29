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

group('Each tab strip agrees with its sidebar section');
// A page reachable from one but not the other is invisible from wherever it
// was forgotten — and nothing fails, so only a person notices.
for (const [section, tabs] of [
  ['Operations', CONTROL_TABS],
  ['Administration', ADMIN_TABS],
]) {
  const sidebarHrefs = new Set((NAV_SECTIONS.find((s) => s.title === section)?.items ?? []).map((i) => i.href));
  const tabHrefs = new Set(tabs.map((i) => i.href));
  const missingFromTabs = [...sidebarHrefs].filter((h) => !tabHrefs.has(h));
  const missingFromSidebar = [...tabHrefs].filter((h) => !sidebarHrefs.has(h));
  check(`${section}: every sidebar page has a tab`, missingFromTabs.length === 0, missingFromTabs.join(', '));
  check(`${section}: every tab has a sidebar entry`, missingFromSidebar.length === 0, missingFromSidebar.join(', '));
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
