#!/usr/bin/env node
/**
 * Import GEM's Global Energy Ownership Tracker (GEOT) as key accounts.
 *
 *   node scripts/import-geot.mjs "path/to/Global-Energy-Ownership-Tracker.xlsx" [--dry]
 *
 * Builds, from the workbook:
 *   1. an entity registry            (All Entities)
 *   2. the corporate ownership graph (Entity Ownership: parents + subsidiaries)
 *   3. a portfolio rollup per owner  (per-tracker Ownership sheets: assets,
 *      operating MW, pipeline count, verticals, GEM location ids)
 * then filters out passive financial holders, scores each owner with the
 * key-account rubric, and upserts:
 *   - canonical_projects  (one `account` record per owner, source_key 'geot')
 *   - account_enrichment  (ownership hierarchy + portfolio + key_account_score)
 *
 * --dry prints a summary and the top accounts without touching the database.
 * Reads Supabase creds from .env.local (SUPABASE_SECRET_KEY / _SERVICE_ROLE_KEY).
 */
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';

const FILE = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!FILE) {
  console.error('Usage: node scripts/import-geot.mjs <file.xlsx> [--dry]');
  process.exit(1);
}

// ---- env ----
function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnv();
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---- helpers ----
const num = (v) => {
  if (v === null || v === undefined || v === '' || v === '--') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
};
const push = (map, k, v) => {
  if (!k) return;
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(v);
};
function accountKey(name) {
  if (!name) return null;
  const k = String(name).toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|plc|group|holdings|sa|spa|gmbh|ag|bv|pty|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return k.length ? k : null;
}
const APAC = new Set(['china','india','japan','south korea','korea, south','republic of korea','korea','australia','new zealand','indonesia','vietnam','viet nam','philippines','thailand','malaysia','singapore','taiwan','bangladesh','pakistan','myanmar','cambodia','laos','sri lanka','nepal','mongolia','hong kong','papua new guinea']);
function bu(country) {
  const c = (country || '').trim().toLowerCase();
  if (/united states|u\.?s\.?a?\b|america/.test(c)) return 'usa';
  if (/northern ireland/.test(c)) return 'uk';
  if (/united kingdom|great britain|england|scotland|wales/.test(c)) return 'uk';
  if (/\bireland\b/.test(c)) return 'ireland';
  if (APAC.has(c)) return 'apac';
  return 'export';
}
// passive financial holders / non-actionable buckets to exclude
const PASSIVE = /asset manage|advisor|investment manage|\bcapital\b|\bfund\b|\bfunds\b|blackrock|vanguard|state street|\bbank\b|insurance|pension|\btrust\b|mutual|securities|financial group|nominee|small shareholder|natural person|unknown|member\/employee|not disclosed|other investor|private individual/i;
const isPassive = (name) => !name || PASSIVE.test(name);

const PIPELINE = new Set(['construction','pre-construction','announced','proposed','permitted','planned']);

// ---- key-account rubric (mirrors src/lib/keyaccount.ts, tuned for asset portfolios) ----
function scoreAccount(p, subs) {
  const c01 = (x) => Math.max(0, Math.min(1, x));
  let s = 15; // operating owner base
  const reasons = [];
  s += 25 * c01(p.assets / 10);
  if (p.assets >= 3) reasons.push(`${p.assets} energy assets`);
  s += 20 * c01(p.pipeline / 5);
  if (p.pipeline > 0) reasons.push(`${p.pipeline} in construction/planning`);
  s += 20 * c01(p.operatingMW / 5000);
  if (p.operatingMW > 0) reasons.push(`${Math.round(p.operatingMW).toLocaleString()} MW operating`);
  s += 20 * c01(subs / 15);
  if (subs >= 3) reasons.push(`${subs} subsidiaries`);
  s = Math.round(Math.min(100, s));
  const isKey = p.assets >= 3 || p.operatingMW >= 1000 || p.pipeline >= 2 || subs >= 5 || s >= 55;
  return { score: s, reasons, isKey };
}

// ---- read workbook ----
console.log(`Reading ${path.basename(FILE)} …`);
const wb = XLSX.read(fs.readFileSync(FILE), { cellDates: false });
const rows = (name) => (wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null }) : []);

// 1. entities
const entities = new Map();
for (const r of rows('All Entities')) {
  const id = r['Entity ID'];
  if (id) entities.set(id, {
    name: r['Full Name'] || r['Name'],
    type: r['Legal Entity Type'],
    listed: r['PubliclyListed'],
    homepage: r['Home Page'],
    country: r['Headquarters Country'] || r['Registration Country'],
  });
}

// 2. ownership graph
const subsidiaries = new Map(); // ownerId -> [{id,name,share}]
const parentsOf = new Map();    // subjectId -> [{id,name,share}]
for (const r of rows('Entity Ownership')) {
  const subj = r['Subject Entity ID'], subjN = r['Subject Entity Name'];
  const ip = r['Interested Party ID'], ipN = r['Interested Party Name'], share = r['% Share of Ownership'];
  push(subsidiaries, ip, { id: subj, name: subjN, share });
  push(parentsOf, subj, { id: ip, name: ipN, share });
}

// 3. portfolio rollup from per-tracker ownership sheets
const TRACKER_SHEETS = ['Coal Plant Ownership','Gas Plant Ownership','Bioenergy Power Ownership','Coal Mine Ownership','Iron Mine Ownership','Gas Pipeline Ownership','Oil & NGL Pipeline Ownership','Steel Plant Ownership','Cement and Concrete Ownership'];
const portfolio = new Map(); // ownerId -> rollup
for (const s of TRACKER_SHEETS) {
  for (const r of rows(s)) {
    const ownerId = r['Immediate Project Owner Entity ID'] || r['Parent GEM Entity ID'] || r['Owner GEM Entity ID'];
    const ownerName = r['Immediate Project Owner'] || r['Parent'];
    if (!ownerId || !ownerName) continue;
    const cap = num(r['Capacity (MW)']);
    const status = String(r['Status'] || '').toLowerCase();
    const gemLoc = r['GEM location ID'];
    let p = portfolio.get(ownerId);
    if (!p) { p = { name: ownerName, assets: 0, operatingMW: 0, pipeline: 0, trackers: new Set(), projects: [], gemLocs: new Set(), units: new Set(), country: r['Parent Headquarters Country'] || r['Parent Registration Country'] }; portfolio.set(ownerId, p); }
    // Dedup: an asset unit can appear on several ownership-path rows for the
    // same owner — count each distinct unit once.
    const unit = r['GEM unit ID'] || r['GEM location ID'] || r['Project'];
    if (unit && p.units.has(unit)) continue;
    if (unit) p.units.add(unit);
    p.assets++;
    if (status === 'operating' && cap) p.operatingMW += cap;
    if (PIPELINE.has(status)) p.pipeline++;
    p.trackers.add(String(r['Tracker'] || s).replace(/ Ownership$/, ''));
    if (p.projects.length < 12) p.projects.push({ name: r['Project'], stage: r['Status'], est_value: null, location: r['Parent Headquarters Country'] });
    if (gemLoc && gemLoc !== 'unknown') p.gemLocs.add(gemLoc);
  }
}

// 4. Merge owners that share an account_key (name-normalized), combining their
//    portfolios + hierarchy — several GEM entity ids can map to one company, and
//    the DB conflict key is account_key, so each must appear exactly once.
const byKey = new Map();
let skipped = 0;
for (const [id, p] of portfolio) {
  if (isPassive(p.name)) { skipped++; continue; }
  const key = accountKey(p.name);
  if (!key) { skipped++; continue; }
  let m = byKey.get(key);
  if (!m) { m = { name: p.name, assets: 0, operatingMW: 0, pipeline: 0, trackers: new Set(), projects: [], gemLocs: new Set(), country: null, entityIds: new Set() }; byKey.set(key, m); }
  m.assets += p.assets;
  m.operatingMW += p.operatingMW;
  m.pipeline += p.pipeline;
  for (const t of p.trackers) m.trackers.add(t);
  for (const pr of p.projects) if (m.projects.length < 12) m.projects.push(pr);
  for (const g of p.gemLocs) m.gemLocs.add(g);
  m.entityIds.add(id);
  if (p.name.length > m.name.length) m.name = p.name; // keep the fuller name
  const ent = entities.get(id) || {};
  if (!m.country) m.country = ent.country || p.country || null;
}

// 5. build one account + enrichment row per account_key
// Sanity cap: a handful of GEOT entities are used as ownership-path aggregators
// and absorb implausible asset counts (e.g. ALLETE ~21k) — drop these artifacts.
const MAX_ASSETS = 3000;
let artifacts = 0;
const accountRows = [];
const enrichmentRows = [];
for (const [key, m] of byKey) {
  if (m.assets > MAX_ASSETS) { artifacts++; continue; }
  // union hierarchy across all merged entity ids
  const subMap = new Map(), parMap = new Map();
  for (const id of m.entityIds) {
    for (const s of subsidiaries.get(id) || []) subMap.set(s.id || s.name, s);
    for (const pr of parentsOf.get(id) || []) parMap.set(pr.id || pr.name, pr);
  }
  const subs = [...subMap.values()];
  const pars = [...parMap.values()];
  const verticals = [...m.trackers];
  const ka = scoreAccount(m, subs.length);

  accountRows.push({
    canonical_name: m.name.slice(0, 300),
    source_key: 'geot',
    source_unique_id: key,
    account_key: key,
    record_type: 'account',
    bu: bu(m.country),
    project_type: verticals[0] || 'Energy',
    building_type: verticals.join(', ') || 'Energy',
    description: `${m.assets} assets (${m.pipeline} in build/planning), ${Math.round(m.operatingMW).toLocaleString()} MW operating across ${verticals.join(', ')}`,
    country: m.country,
    company_name_raw: m.name,
    capacity_mw: Math.round(m.operatingMW) || null,
    processing_status: 'normalized',
    source_completeness_tier: 'C',
    source_completeness_score: 60,
    fields_populated: {},
    fields_missing: [],
    population_percentage: 60,
    field_provenance: { company_name_raw: 'source', capacity_mw: 'source', country: 'source' },
    raw_data: { __source: 'geot', entity_ids: [...m.entityIds], assets: m.assets, operating_mw: Math.round(m.operatingMW), pipeline: m.pipeline, trackers: verticals, gem_location_ids: [...m.gemLocs].slice(0, 200) },
  });

  enrichmentRows.push({
    account_key: key,
    account_name: m.name,
    account_role: 'owner',
    parent_account: pars[0]?.name || null,
    related_entities: [
      ...pars.map((x) => ({ name: x.name, role: 'parent', relationship: 'shareholder', share: x.share, entity_id: x.id })),
      ...subs.slice(0, 25).map((x) => ({ name: x.name, role: 'subsidiary', relationship: 'subsidiary', share: x.share, entity_id: x.id })),
    ],
    related_projects: m.projects,
    portfolio_project_count: m.assets,
    portfolio_value_estimate: null,
    expansion_signal: m.pipeline > 0 ? `${m.pipeline} assets in construction/planning` : null,
    tech_stack: [],
    key_account: ka.isKey,
    key_account_score: ka.score,
    key_account_reasons: ka.reasons,
    field_provenance: { account_name: 'source', related_entities: 'source', related_projects: 'source', portfolio_project_count: 'source', key_account_score: 'source' },
    enrichment_jobs: [],
  });
}

// ---- summary ----
const key = enrichmentRows.filter((e) => e.key_account).length;
console.log(`\nEntities: ${entities.size.toLocaleString()} · ownership links: ${subsidiaries.size.toLocaleString()} owners`);
console.log(`Owners with a portfolio: ${portfolio.size.toLocaleString()} · passive/generic skipped: ${skipped.toLocaleString()} · data artifacts (>${MAX_ASSETS} assets) dropped: ${artifacts}`);
console.log(`Actionable accounts: ${accountRows.length.toLocaleString()} · KEY accounts: ${key.toLocaleString()}`);
const top = enrichmentRows.slice().sort((a, b) => b.key_account_score - a.key_account_score).slice(0, 15);
console.log('\nTop accounts by key-account score:');
for (const a of top) console.log(`  ${String(a.key_account_score).padStart(3)}  ${a.account_name.slice(0, 40).padEnd(42)} ${a.key_account_reasons.join(' · ')}`);

if (DRY) { console.log('\n--dry: nothing written.'); process.exit(0); }
if (!URL || !KEY) { console.error('\nNo Supabase creds in .env.local (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY). Use --dry to preview.'); process.exit(1); }

// ---- upsert ----
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
async function upsert(table, rowsArr, conflict) {
  let done = 0, ok = true;
  for (let i = 0; i < rowsArr.length; i += 250) {
    const chunk = rowsArr.slice(i, i + 250);
    const { error } = await sb.from(table).upsert(chunk, { onConflict: conflict });
    if (error) { console.error(`\n  ${table} chunk ${i} error: ${error.message}`); ok = false; break; }
    done += chunk.length;
    process.stdout.write(`\r  ${table}: ${done}/${rowsArr.length}`);
  }
  console.log('');
  return ok;
}
console.log('\nWriting to Supabase …');
const a = await upsert('canonical_projects', accountRows, 'source_key,source_unique_id');
const b = a && (await upsert('account_enrichment', enrichmentRows, 'account_key'));
if (a && b) console.log(`\nDone. ${accountRows.length} accounts (${key} key) imported. See them at /accounts.`);
else console.log('\nImport did not complete — see error above.');
process.exitCode = a && b ? 0 : 1; // let the event loop drain instead of exit() mid-async
