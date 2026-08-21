/**
 * Flag radar leads whose company is already in the CRM.
 *
 *   node --experimental-transform-types --no-warnings \
 *     --import ./scripts/lib/register-alias.mjs scripts/crm-import.mjs <export.csv> [--apply]
 *
 * Reads an Accounts export straight out of Zoho — no OAuth, no API credentials,
 * no cron. In Zoho: Accounts → the list view menu → Export, with at least
 * `Account Name`, `Website` and `Account Type` selected. Re-run it whenever the
 * CRM has moved on; the matcher is stateless and the flags are simply rewritten.
 *
 * WHY AN EXPORT RATHER THAN A SYNC
 *
 * The overlap was measured before any of this was built. Of the fifty most common
 * companies in the workable book, nine matched a CRM account cleanly and four
 * matched something wrong — a projected few hundred flagged leads out of 111,802.
 * A nightly Zoho sync is not worth building for that, and would need credentials
 * nobody has issued. A file the CRM already knows how to produce costs nothing and
 * is refreshed by running this again.
 *
 * DRY BY DEFAULT
 *
 * Without `--apply` it writes nothing and prints what it would do, including the
 * ambiguous cases it refused. That report is the point: it is how anybody checks
 * the matching before believing a badge that says a live prospect is do-not-call.
 */

import { readFileSync } from 'node:fs';
import { buildCrmIndex, matchCrmAccount, crmSignal } from '@/lib/crm/accountMatch';

const [, , filePath, ...flags] = process.argv;
const APPLY = flags.includes('--apply');

if (!filePath) {
  console.error('usage: crm-import.mjs <zoho-accounts-export.csv|.json> [--apply]');
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* Reading what Zoho produced                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A CSV parser that survives the field this file exists to read.
 *
 * Account names contain commas (`Weitz CO. & Affiliates`), quotes, and at least
 * one embedded newline in the live data. A `split(',')` would shear those rows
 * into fragments and quietly produce garbage account names — which then match
 * nothing, so the failure looks like "the CRM has no overlap" rather than like a
 * parser bug. That is exactly the kind of silent zero this codebase has been
 * bitten by before, so the parser handles quoting properly.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim()));
}

/** Zoho's export header names vary by locale and layout; accept the usual shapes. */
function pick(header, ...candidates) {
  for (const c of candidates) {
    const i = header.findIndex((h) => h.trim().toLowerCase() === c.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function loadAccounts(path) {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) {
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : (data.data ?? []);
    return list.map((a) => ({
      id: String(a.id ?? a.Id ?? ''),
      name: a.Account_Name ?? a['Account Name'] ?? a.name ?? '',
      website: a.Website ?? a.website ?? null,
      accountType: a.Account_Type ?? a['Account Type'] ?? a.accountType ?? null,
    }));
  }
  const rows = parseCsv(raw);
  if (!rows.length) return [];
  const header = rows[0];
  const iId = pick(header, 'Record Id', 'Account Id', 'id');
  const iName = pick(header, 'Account Name', 'Account_Name', 'name');
  const iSite = pick(header, 'Website', 'website');
  const iType = pick(header, 'Account Type', 'Account_Type', 'Type');
  if (iName < 0) {
    console.error('No "Account Name" column found. Header was:\n  ' + header.join(' | '));
    process.exit(2);
  }
  if (iType < 0) {
    console.error('No "Account Type" column found — that field IS the feature; re-export including it.');
    process.exit(2);
  }
  return rows.slice(1).map((r) => ({
    id: iId >= 0 ? (r[iId] ?? '').trim() : '',
    name: (r[iName] ?? '').trim(),
    website: iSite >= 0 ? (r[iSite] ?? '').trim() || null : null,
    accountType: (r[iType] ?? '').trim() || null,
  }));
}

/* -------------------------------------------------------------------------- */
/* Supabase, over PostgREST                                                    */
/* -------------------------------------------------------------------------- */

function env() {
  const text = readFileSync('.env.local', 'utf8');
  const get = (k) => {
    const m = text.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const url = get('NEXT_PUBLIC_SUPABASE_URL') || get('SUPABASE_URL');
  const key = get('SUPABASE_SECRET_KEY') || get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    console.error('Missing Supabase URL or service key in .env.local');
    process.exit(2);
  }
  return { url, key };
}

const { url: SB, key: SB_KEY } = env();
const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

/**
 * Walk the table by key, not by offset.
 *
 * The obvious `offset=N&limit=1000` died at 35,000 rows with a statement timeout,
 * and would have died at some point no matter how small the page: OFFSET makes
 * Postgres produce and discard every preceding row, so page 35 costs thirty-five
 * times page 1. Seeking on the indexed primary key instead is flat, and this table
 * has form for timing out under concurrent ingest.
 */
async function* pagedRecords(pageSize = 1000) {
  let after = null;
  for (;;) {
    const q =
      `${SB}/rest/v1/canonical_projects` +
      `?select=id,company_name_raw,company_domain,company_website` +
      `&company_name_raw=not.is.null&order=id.asc&limit=${pageSize}` +
      (after ? `&id=gt.${encodeURIComponent(after)}` : '');
    const res = await fetch(q, { headers });
    if (!res.ok) throw new Error(`read failed: HTTP ${res.status} ${await res.text()}`);
    const rows = await res.json();
    if (!rows.length) return;
    yield rows;
    if (rows.length < pageSize) return;
    after = rows[rows.length - 1].id;
  }
}

/**
 * One PATCH per matched record.
 *
 * A bulk upsert would be fewer requests and is the wrong tool: POST with
 * merge-duplicates builds an INSERT, and this table has NOT NULL columns and four
 * STORED generated columns. Every id here already exists so it would always take
 * the conflict branch — right up until one does not, and then it fails in a way
 * that has nothing to do with what this script is for.
 *
 * The volume makes it moot anyway. Matching was measured at a few hundred records
 * out of 111,802, so this is hundreds of small requests, not thousands.
 */
async function writeBatch(updates) {
  for (const u of updates) {
    const { id, ...fields } = u;
    const res = await fetch(`${SB}/rest/v1/canonical_projects?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify(fields),
    });
    if (!res.ok) throw new Error(`write failed for ${id}: HTTP ${res.status} ${await res.text()}`);
  }
}

/* -------------------------------------------------------------------------- */

const accounts = loadAccounts(filePath);
const index = buildCrmIndex(accounts);
console.log(
  `CRM export: ${accounts.length} accounts, ${index.size} matchable ` +
    `(${index.skipped} skipped as junk or untyped), ` +
    `${index.byDomain.size} distinct domains, ${index.byName.size} distinct names.`
);
if (!index.size) {
  console.error('Nothing matchable in that file — check the Account Type column exported.');
  process.exit(1);
}

const tally = { matched: 0, ambiguous: 0, no_match: 0 };
const bySignal = {};
const byBasis = {};
const samples = [];
const ambiguities = [];
let scanned = 0;
let written = 0;
let pending = [];
const stamp = new Date().toISOString();

for await (const rows of pagedRecords()) {
  for (const r of rows) {
    scanned++;
    const m = matchCrmAccount(
      { companyName: r.company_name_raw, domain: r.company_domain, website: r.company_website },
      index
    );
    tally[m.status]++;
    if (m.status === 'ambiguous' && ambiguities.length < 15) {
      ambiguities.push(`${r.company_name_raw} → ${m.reason} [${m.candidates.map((c) => c.accountType).join(', ')}]`);
    }
    if (m.status !== 'matched' || !m.account) continue;

    const sig = crmSignal(m.account.accountType);
    bySignal[sig] = (bySignal[sig] ?? 0) + 1;
    byBasis[m.basis] = (byBasis[m.basis] ?? 0) + 1;
    if (samples.length < 20) {
      samples.push(`${(r.company_name_raw ?? '').slice(0, 38).padEnd(38)} → ${m.account.name.slice(0, 34).padEnd(34)} ${sig}/${m.confidence} (${m.basis})`);
    }

    pending.push({
      id: r.id,
      crm_account_id: m.account.id || null,
      crm_account_name: m.account.name,
      crm_account_type: m.account.accountType,
      crm_signal: sig,
      crm_match_basis: m.basis,
      crm_match_confidence: m.confidence,
      crm_matched_at: stamp,
    });
    if (APPLY && pending.length >= 500) {
      await writeBatch(pending);
      written += pending.length;
      pending = [];
    }
  }
  process.stdout.write(`\r  scanned ${scanned.toLocaleString()}…`);
}
if (APPLY && pending.length) {
  await writeBatch(pending);
  written += pending.length;
}

console.log(`\r  scanned ${scanned.toLocaleString()} records with a company name.\n`);
console.log(`  matched    ${String(tally.matched).padStart(7)}`);
console.log(`  ambiguous  ${String(tally.ambiguous).padStart(7)}   (refused — never flagged)`);
console.log(`  no match   ${String(tally.no_match).padStart(7)}`);

console.log('\nBy what the rep should do:');
for (const [k, v] of Object.entries(bySignal).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(10)} ${String(v).padStart(6)}`);
}
console.log('\nBy evidence:');
for (const [k, v] of Object.entries(byBasis)) console.log(`  ${k.padEnd(10)} ${String(v).padStart(6)}`);

if (samples.length) {
  console.log('\nSample matches — read these before trusting the badge:');
  for (const s of samples) console.log('  ' + s);
}
if (ambiguities.length) {
  console.log('\nRefused as ambiguous (a human can still resolve these):');
  for (const a of ambiguities) console.log('  ' + a);
}

console.log(
  APPLY
    ? `\nWrote ${written.toLocaleString()} flags.`
    : '\nDry run — nothing written. Re-run with --apply once the samples above look right.'
);
