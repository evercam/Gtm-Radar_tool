/**
 * ConstructConnect collector.
 *
 * Runs a browser, signs in to the account, opens saved searches, and captures
 * the project documents the web app receives — then posts them to Source Hub,
 * which normalises them with the same mapper the paid API uses.
 *
 * Why this is a separate program and not part of the app: Chromium is ~300 MB
 * and a Vercel function may be 250 MB, so a browser cannot run there. It runs
 * in GitHub Actions instead (see .github/workflows/construct-connect.yml).
 *
 * It captures the network layer rather than reading the page. The DOM changes
 * whenever the vendor restyles anything; the JSON behind it changes only when
 * they change the data itself. Scraping the DOM would also lose every field
 * the table does not happen to display, and the normaliser wants all of them.
 *
 * ─── First run ───────────────────────────────────────────────────────────
 *   node collectors/construct-connect/collect.mjs --discover
 *
 * That opens a visible browser and writes every JSON response it sees to
 * ./discovery/. Look for the one holding the project list, then set
 * RESULTS_URL_MATCH and DOCS_PATH below. Nothing else needs changing.
 *
 * ─── Normal run ──────────────────────────────────────────────────────────
 *   CC_EMAIL=… CC_PASSWORD=… HUB_URL=… HUB_SECRET=… \
 *     node collectors/construct-connect/collect.mjs
 *
 * Note: automating a logged-in session is generally against a vendor's terms
 * of service. The account is yours and the risk of losing it is yours to take.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

// ─── configure ────────────────────────────────────────────────────────────

/** Saved searches to run. Add as many as you like. */
const SEARCHES = [
  {
    name: 'Awarded Spec Next 90D',
    url: 'https://app.constructconnect.com/results?area=project&selectedContexts=documents&savedSearch=true&name=Awarded+Spec+Next+90D+V2&sort=startDate&sortDir=desc',
  },
];

/**
 * Which response carries the results. Set this from the discovery run.
 * Left broad on purpose so the first real run has a chance of matching.
 */
const RESULTS_URL_MATCH = /projectleads|\/search|\/projects|graphql/i;

/**
 * Where the documents sit inside that response. Each entry is tried in order,
 * so leaving several costs nothing and survives a vendor rename.
 */
const DOCS_PATH = ['docs', 'results', 'projects', 'items', 'data.docs', 'data.projects', 'data.results'];

const LOGIN_URL = 'https://app.constructconnect.com/login';
const AUTH_FILE = 'collectors/construct-connect/.auth.json';

// ─── plumbing ─────────────────────────────────────────────────────────────

const DISCOVER = process.argv.includes('--discover');
const DRY_RUN = process.argv.includes('--dry-run');

const env = (k, required = true) => {
  const v = process.env[k];
  if (!v && required) {
    console.error(`Missing ${k}.`);
    process.exit(1);
  }
  return v;
};

/** Reads a dotted path, so 'data.docs' works as well as 'docs'. */
function at(obj, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/** The first array of objects found at any candidate path. */
function findDocs(body) {
  if (Array.isArray(body) && body.length && typeof body[0] === 'object') return body;
  if (!body || typeof body !== 'object') return null;
  for (const path of DOCS_PATH) {
    const v = at(body, path);
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return null;
}

async function main() {
  const email = env('CC_EMAIL');
  const password = env('CC_PASSWORD');
  const hubUrl = env('HUB_URL', !DISCOVER && !DRY_RUN);
  const hubSecret = env('HUB_SECRET', !DISCOVER && !DRY_RUN);

  const browser = await chromium.launch({
    headless: !DISCOVER,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    // Reusing a saved session avoids signing in on every run, which is both
    // slower and the part most likely to trip a bot check.
    ...(existsSync(AUTH_FILE) ? { storageState: AUTH_FILE } : {}),
  });

  // navigator.webdriver is the single most-checked automation tell.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  const captured = [];
  let seen = 0;

  page.on('response', async (res) => {
    const url = res.url();
    if (!/\/api\/|graphql|json/i.test(url)) return;
    let body;
    try {
      body = await res.json();
    } catch {
      return;
    }
    seen += 1;

    if (DISCOVER) {
      mkdirSync('discovery', { recursive: true });
      const name = `discovery/${String(seen).padStart(3, '0')}-${url.split('/').pop()?.slice(0, 40).replace(/[^\w.-]/g, '_')}.json`;
      writeFileSync(name, JSON.stringify({ url, body }, null, 2));
      const docs = findDocs(body);
      if (docs) console.log(`  ${docs.length} document(s) at ${url.slice(0, 90)}`);
      return;
    }

    if (!RESULTS_URL_MATCH.test(url)) return;
    const docs = findDocs(body);
    if (docs) {
      captured.push(...docs);
      console.log(`  captured ${docs.length} (total ${captured.length})`);
    }
  });

  // ── sign in if the saved session has lapsed ────────────────────────────
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (/login|signin/i.test(page.url())) {
    console.log('signing in…');
    await page.fill('input[type="email"], input[name="email"], input[name="username"]', email);
    await page.fill('input[type="password"], input[name="password"]', password);
    await page.click('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');
    try {
      await page.waitForURL((u) => !/login|signin/i.test(u.toString()), { timeout: 45_000 });
    } catch {
      // An MFA prompt or a bot check lands here. Nothing useful follows, and a
      // screenshot is the only way to see which it was.
      await page.screenshot({ path: 'login-failed.png' });
      console.error('Sign-in did not complete — see login-failed.png. MFA or a bot check is the usual cause.');
      await browser.close();
      process.exit(1);
    }
    await context.storageState({ path: AUTH_FILE });
    console.log('signed in, session saved');
  } else {
    console.log('existing session still valid');
  }

  // ── run each saved search ─────────────────────────────────────────────
  for (const search of SEARCHES) {
    console.log(`\n${search.name}`);
    captured.length = 0;
    await page.goto(search.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // The results arrive by XHR after the shell renders, so waiting for the
    // network to settle is what waiting for the data actually looks like.
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    if (DISCOVER) {
      console.log(`\n${seen} JSON response(s) written to ./discovery/`);
      console.log('Find the file holding the project list, then set RESULTS_URL_MATCH and DOCS_PATH.');
      continue;
    }

    if (captured.length === 0) {
      await page.screenshot({ path: `no-results-${search.name.replace(/\W+/g, '-')}.png` });
      console.error('  nothing captured — run with --discover to see what the page actually returns');
      continue;
    }

    if (DRY_RUN) {
      writeFileSync('captured.json', JSON.stringify(captured, null, 2));
      console.log(`  ${captured.length} document(s) written to captured.json`);
      continue;
    }

    // Posted in pages: the endpoint refuses more than 1000 at once, because a
    // single huge upsert times out and leaves the run unrecorded.
    for (let i = 0; i < captured.length; i += 500) {
      const chunk = captured.slice(i, i + 500);
      const res = await fetch(`${hubUrl}/api/ingest/construct-connect/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': hubSecret },
        body: JSON.stringify({ docs: chunk, query: search.name }),
      });
      const json = await res.json().catch(() => ({}));
      console.log(`  → hub: ${json.message ?? `HTTP ${res.status}`}`);
      if (json.ok === false) process.exitCode = 1;
    }
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
