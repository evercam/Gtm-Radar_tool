/**
 * Ingest a Project Intelligence stakeholder export into canonical_projects.
 *
 *   node --env-file=.env.local --experimental-strip-types scripts/ingest-stakeholders.mjs <file.csv> [--commit]
 *
 * Dry-runs by default and prints exactly what would land. Pass --commit to
 * write. Upserts on (source_key, source_unique_id), so re-running the same
 * export updates rather than duplicates.
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { normalizeStakeholderCsv, STAKEHOLDER_SOURCE } from '../src/lib/import/stakeholders.ts';

const file = process.argv[2];
const commit = process.argv.includes('--commit');
if (!file) {
  console.error('usage: ingest-stakeholders.mjs <file.csv> [--commit]');
  process.exit(1);
}

const { records, parsed, failed } = normalizeStakeholderCsv(readFileSync(file, 'utf8'));

const count = (fn) => records.reduce((n, r) => n + (fn(r) ? 1 : 0), 0);
const uniq = (fn) => new Set(records.map(fn).filter(Boolean)).size;

console.log(`\nParsed ${parsed} rows -> ${records.length} records (${failed} skipped)`);
console.log(`  projects        ${uniq((r) => r.raw_data.project_id)}`);
console.log(`  companies       ${uniq((r) => r.account_key)}`);
console.log(`  with email      ${count((r) => r.contact_email)}`);
console.log(`  with phone      ${count((r) => r.contact_phone)}`);
console.log(`  with LinkedIn   ${count((r) => r.raw_data.linkedin_url)}`);

const by = (fn) => {
  const m = new Map();
  for (const r of records) {
    const k = fn(r) ?? '(none)';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
console.log('\n  BU            ', by((r) => r.bu).map(([k, v]) => `${k}:${v}`).join('  '));
console.log('  ICP           ', by((r) => r.icp_code).map(([k, v]) => `${k}:${v}`).join('  '));
console.log('  tier          ', by((r) => r.source_completeness_tier).map(([k, v]) => `${k}:${v}`).join('  '));
console.log('  phase         ', by((r) => r.current_phase).map(([k, v]) => `${k}:${v}`).join('  '));
console.log('  state         ', by((r) => r.state_province).slice(0, 8).map(([k, v]) => `${k}:${v}`).join('  '));

const noState = records.filter((r) => !r.state_province);
if (noState.length) {
  console.log(`\n  ${noState.length} records with no state parsed, e.g.:`);
  for (const r of noState.slice(0, 5)) console.log(`    ${r.raw_data.project_location}`);
}

console.log('\nSample record:');
console.log(JSON.stringify(records[0], null, 2).slice(0, 1400));

if (!commit) {
  console.log('\nDry run — nothing written. Re-run with --commit to persist.');
  process.exit(0);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY.');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const ids = records.map((r) => r.source_unique_id);
const existing = new Set();
for (let i = 0; i < ids.length; i += 200) {
  const { data, error } = await supabase
    .from('canonical_projects')
    .select('source_unique_id')
    .eq('source_key', STAKEHOLDER_SOURCE)
    .in('source_unique_id', ids.slice(i, i + 200));
  if (error) {
    console.error('Pre-check failed:', error.message);
    process.exit(1);
  }
  for (const r of data ?? []) existing.add(r.source_unique_id);
}

let written = 0;
for (let i = 0; i < records.length; i += 100) {
  const chunk = records.slice(i, i + 100);
  const { error } = await supabase
    .from('canonical_projects')
    .upsert(chunk, { onConflict: 'source_key,source_unique_id' });
  if (error) {
    console.error(`Chunk at ${i} failed:`, error.message);
    process.exit(1);
  }
  written += chunk.length;
  process.stdout.write(`\r  written ${written}/${records.length}`);
}

const inserted = records.length - existing.size;
console.log(`\n\nDone — ${inserted} new, ${existing.size} updated, source_key "${STAKEHOLDER_SOURCE}".`);
