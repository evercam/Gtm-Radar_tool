/**
 * ConstructConnect collector — browsing, not intercepting.
 *
 * The sibling collect.mjs waits for the app's own API response and forwards it.
 * That is the better data when it works, but it needs to know which response
 * carries the results, and two attempts to guess that were wrong. This one
 * needs to know nothing: it drives the interface the way a person does, clicks
 * the saved search by the name shown on screen, and reads the table.
 *
 * What that costs: only the columns the table actually displays, so the
 * records are thinner than the API's. Enrichment fills a lot of it back, and
 * a thin record today beats a complete one that never arrives.
 *
 *   node collectors/construct-connect/browse.mjs --dry-run   # writes a file
 *   node collectors/construct-connect/browse.mjs             # posts to the hub
 *
 * --show opens a visible browser, which is worth it the first time.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

/**
 * Fills in anything not already in the environment from .env.local.
 *
 * HUB_URL and HUB_SECRET are already there for the app, so asking for them a
 * second time would only invite copying a secret around by hand — the thing
 * most likely to end up pasted somewhere it should not be. Existing
 * environment variables win, so CI (which has no .env.local) is unaffected.
 */
function loadEnvLocal() {
  if (!existsSync('.env.local')) return;
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key]) continue;
    process.env[key] = raw.trim().replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

const SEARCHES = ['Awarded Spec Next 90D V2', 'Data Centers USA', 'Priority 1 Spec 90D Awarded - 3M+'];

const HOME = 'https://app.constructconnect.com';
const AUTH_FILE = 'collectors/construct-connect/.auth.json';

const DRY = process.argv.includes('--dry-run');
const SHOW = process.argv.includes('--show');
/** Skip the per-project pass and take only what the table shows. */
const LIST_ONLY = process.argv.includes('--list-only');
/**
 * How many projects to open per search. Each one is a page load, so this is
 * the difference between a two-minute run and an hour-long one — and a long
 * run of rapid sequential loads is also the most bot-like thing here.
 */
const DETAIL_LIMIT = Number(process.argv.find((a) => a.startsWith('--details='))?.split('=')[1] ?? 60);

const need = (k, required = true) => {
  const v = process.env[k];
  if (!v && required) {
    console.error(`Missing ${k}.`);
    process.exit(1);
  }
  return v;
};

/**
 * Column headings the table shows, against the field names the app's
 * ConstructConnect normaliser already expects. Matched loosely and on a
 * substring, because the heading is written for a person, not for us.
 */
const COLUMNS = [
  [/^project\s*name|^project$|^title|^name/i, 'title'],
  [/value|amount|\$|budget/i, 'projectValue'],
  [/stage|status/i, 'projectStatus'],
  [/bid\s*date|bid$/i, 'bidDate'],
  [/start|construction\s*date/i, 'startDate'],
  [/city|town/i, '_city'],
  [/state|province/i, '_state'],
  [/county/i, '_county'],
  [/type|use|category/i, 'propertyType'],
  [/owner|company|firm|contractor/i, '_company'],
  [/updated|modified/i, 'lastUpdatedDate'],
];

const fieldFor = (heading) => COLUMNS.find(([re]) => re.test(heading.trim()))?.[1] ?? null;

/** "$12.5M" / "1,250,000" → a number, or null when there is nothing to read. */
function money(text) {
  if (!text) return null;
  const t = String(text).replace(/[,\s$]/g, '');
  const m = t.match(/^([\d.]+)([KMB])?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

async function main() {
  const email = need('CC_EMAIL');
  const password = need('CC_PASSWORD');
  // Falls back to the deployment this repo is linked to, so a local run needs
  // no configuration beyond the ConstructConnect credentials.
  const hubUrl = process.env.HUB_URL ?? 'https://evercam-raddar.vercel.app';
  const hubSecret = process.env.HUB_SECRET ?? process.env.CRON_SECRET;
  if (!DRY && !hubSecret) {
    console.error('No HUB_SECRET or CRON_SECRET — add CRON_SECRET to .env.local, or use --dry-run.');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: !SHOW,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 1680, height: 1000 },
    ...(existsSync(AUTH_FILE) ? { storageState: AUTH_FILE } : {}),
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  // ── sign in ────────────────────────────────────────────────────────────
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (/login|signin/i.test(page.url())) {
    await page.fill('input[type="email"], input[name="email"], input[name="username"]', email);
    await page.fill('input[type="password"], input[name="password"]', password);
    await page.click('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');
    try {
      await page.waitForURL((u) => !/login|signin/i.test(u.toString()), { timeout: 45_000 });
    } catch {
      await page.screenshot({ path: 'login-failed.png' });
      console.error('Sign-in did not finish — see login-failed.png.');
      await browser.close();
      process.exit(1);
    }
    await context.storageState({ path: AUTH_FILE });
  }
  console.log('signed in');

  for (const name of SEARCHES) {
    console.log(`\n${name}`);

    // Clicking the name on screen, rather than building a URL. The name is
    // what the interface shows and what the account owner recognises; a URL
    // needs an id, and an id guessed wrong loads an empty shell silently.
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(4000);

    const link = page.getByText(name, { exact: false }).first();
    try {
      await link.waitFor({ state: 'visible', timeout: 20_000 });
      await link.click();
    } catch {
      await page.screenshot({ path: `not-found-${name.replace(/\W+/g, '-')}.png` });
      console.error(`  "${name}" is not on the page — see the screenshot. Is the name exact?`);
      continue;
    }

    // Results arrive by XHR after the click; there is no reliable "done"
    // signal, so settle then pause.
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(5000);

    const rows = await readTable(page);
    if (rows.length === 0) {
      await page.screenshot({ path: `no-rows-${name.replace(/\W+/g, '-')}.png`, fullPage: true });
      console.error('  no rows read — see the screenshot for what was on screen');
      continue;
    }
    console.log(`  ${rows.length} row(s) read`);

    let docs = rows.map(toDoc).filter((d) => d.uniqueProjectId && d.title);
    console.log(`  ${docs.length} usable (a row needs both a project link and a name)`);
    if (docs.length === 0) continue;

    // Opening a project makes the application fetch that project's own record,
    // which is the complete one — description, value range, coordinates,
    // contracting method, the fields the list view has no column for. The
    // response is easy to recognise here because the project id is in it,
    // which is exactly what made the search response hard to find.
    if (!LIST_ONLY) {
      docs = await addDetails(page, docs.slice(0, DETAIL_LIMIT)).then((filled) => [
        ...filled,
        ...docs.slice(DETAIL_LIMIT),
      ]);
    }

    if (DRY) {
      const file = `captured-${name.replace(/\W+/g, '-')}.json`;
      writeFileSync(file, JSON.stringify(docs, null, 2));
      console.log(`  written to ${file}`);
      continue;
    }

    for (let i = 0; i < docs.length; i += 500) {
      const res = await fetch(`${hubUrl}/api/ingest/construct-connect/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': hubSecret },
        body: JSON.stringify({ docs: docs.slice(i, i + 500), query: name }),
      });
      const json = await res.json().catch(() => ({}));
      console.log(`  → hub: ${json.message ?? `HTTP ${res.status}`}`);
      if (json.ok === false) process.exitCode = 1;
    }
  }

  await browser.close();
}

/**
 * Opens each project and keeps the record the application fetches for it.
 *
 * Paced deliberately: a browser that opens sixty pages back to back is the
 * least human thing in this script, and the run is not urgent.
 */
async function addDetails(page, docs) {
  const out = [];
  let hits = 0;

  for (const [i, doc] of docs.entries()) {
    /** Responses seen while this one project is open. */
    const seen = [];
    const listener = async (res) => {
      const ct = res.headers()['content-type'] ?? '';
      if (!/json/i.test(ct)) return;
      // Only responses that mention this project, which rules out the
      // analytics and configuration traffic that fires on every page.
      if (!res.url().includes(doc.uniqueProjectId)) return;
      try {
        seen.push(await res.json());
      } catch {
        /* not parseable — nothing to merge */
      }
    };
    page.on('response', listener);

    try {
      await page.goto(doc.projectUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(1200);
    } catch {
      /* a project that will not load is kept as the list row */
    }
    page.off('response', listener);

    // The richest object among them: the project record has more fields than
    // the permissions and preference payloads that also carry the id.
    const best = seen
      .map((b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : null))
      .filter(Boolean)
      .sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0];

    if (best && Object.keys(best).length > 6) {
      hits += 1;
      // Detail wins on conflict, but the list row fills anything it lacks —
      // neither view is a superset of the other.
      out.push({ ...doc, ...best, uniqueProjectId: doc.uniqueProjectId, projectId: doc.projectId });
    } else {
      out.push(doc);
    }

    if ((i + 1) % 10 === 0) console.log(`    opened ${i + 1}/${docs.length} (${hits} with a full record)`);
    await page.waitForTimeout(600 + Math.random() * 900);
  }

  console.log(`  ${hits}/${docs.length} project(s) returned a full record`);
  return out;
}

/**
 * Reads whatever tabular thing is on screen.
 *
 * Tried as a real table first, then as a grid of role="row" — the two shapes
 * this kind of application uses. Each row keeps its project link, because that
 * href carries the only stable id available from the page, and without an id
 * every run would insert the same projects again.
 */
async function readTable(page) {
  return page.evaluate(() => {
    const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

    const fromTable = () => {
      const table = [...document.querySelectorAll('table')]
        .filter((t) => t.querySelectorAll('tbody tr').length >= 2)
        .sort((a, b) => b.querySelectorAll('tbody tr').length - a.querySelectorAll('tbody tr').length)[0];
      if (!table) return null;
      const heads = [...table.querySelectorAll('thead th, thead td')].map((th) => clean(th.textContent));
      const out = [];
      for (const tr of table.querySelectorAll('tbody tr')) {
        const cells = [...tr.querySelectorAll('td')].map((td) => clean(td.textContent));
        if (cells.length === 0) continue;
        const href = tr.querySelector('a[href*="project"], a[href*="Project"]')?.getAttribute('href') ?? null;
        out.push({ heads, cells, href });
      }
      return out.length ? out : null;
    };

    const fromGrid = () => {
      const rows = [...document.querySelectorAll('[role="row"]')];
      if (rows.length < 3) return null;
      const headCells = [...rows[0].querySelectorAll('[role="columnheader"], [role="cell"], [role="gridcell"]')];
      const heads = headCells.map((c) => clean(c.textContent));
      const out = [];
      for (const r of rows.slice(1)) {
        const cells = [...r.querySelectorAll('[role="cell"], [role="gridcell"]')].map((c) => clean(c.textContent));
        if (cells.length === 0) continue;
        const href = r.querySelector('a[href*="project"], a[href*="Project"]')?.getAttribute('href') ?? null;
        out.push({ heads, cells, href });
      }
      return out.length ? out : null;
    };

    return fromTable() ?? fromGrid() ?? [];
  });
}

/** One table row as the document shape the app's normaliser already reads. */
function toDoc(row) {
  const doc = {};
  row.heads.forEach((heading, i) => {
    const field = fieldFor(heading);
    const value = row.cells[i];
    if (!field || !value) return;
    doc[field] = field === 'projectValue' ? money(value) : value;
  });

  // The id comes from the project link — the only stable identifier the page
  // offers. A row without one is dropped rather than inserted afresh every run.
  const id = row.href?.match(/([0-9a-f-]{8,}|\d{5,})/i)?.[1] ?? null;
  if (id) {
    doc.uniqueProjectId = id;
    doc.projectId = id;
    doc.projectUrl = row.href.startsWith('http') ? row.href : `${HOME}${row.href}`;
  }

  if (doc._city || doc._state || doc._county) {
    doc.address = {
      city: doc._city ?? null,
      state: doc._state ?? null,
      county: doc._county ?? null,
      countryCode: 'US',
    };
  }
  if (doc._company) doc.companyNameList = [doc._company];
  for (const k of Object.keys(doc)) if (k.startsWith('_')) delete doc[k];

  return doc;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
