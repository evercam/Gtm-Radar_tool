/**
 * Score every record with the live policy and show what the bands would hold.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/calibrate-scoring.mjs
 *
 * Band thresholds are the only numbers in the scoring policy with no natural
 * value — they are whatever divides the book into piles a team can actually
 * work. Picking them without looking at the distribution is how you end up
 * with P1 empty and 56% of everything in P4, which is where this install
 * started.
 *
 * Read-only by default. `--apply P1,P2,P3` writes those thresholds to the
 * scoring policy through the same validation the UI uses.
 */

import { createClient } from '@supabase/supabase-js';
import {
  scorePriority,
  mergePriorityConfig,
  validatePriorityConfig,
  DEFAULT_PRIORITY_CONFIG,
} from '../src/lib/priority.ts';

const TARGETS = { P1: 0.05, P2: 0.2, P3: 0.5 }; // share of records at or above each band

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } }
);

const { data: policyRow } = await supabase.from('scoring_policy').select('config').eq('id', 'default').maybeSingle();
const config = policyRow?.config ? mergePriorityConfig(policyRow.config) : DEFAULT_PRIORITY_CONFIG;
console.log('Current bands:', JSON.stringify(config.bands));

// PostgREST caps an unpaged select at 1000 rows. Reading these without
// paging silently dropped most of the key-account signals and under-scored
// every affected record by the full keyAccount weight — which is exactly the
// kind of quiet wrongness a calibration tool must not have.
const signals = new Map();
for (let from = 0; from < 500_000; from += 1000) {
  const { data, error } = await supabase
    .from('account_enrichment')
    .select('account_key, key_account, key_account_score')
    .range(from, from + 999);
  if (error) break;
  for (const r of data ?? []) signals.set(r.account_key, r);
  if (!data || data.length < 1000) break;
}
console.log(`Key-account signals loaded: ${signals.size}`);

const COLS =
  'icp_code, record_type, vertical, current_phase, estimated_value, estimated_value_currency, capacity_mw, contact_name, contact_email, contact_phone, contact_status, population_percentage, bid_date, construction_start_date, announced_date, created_at, account_key, bu, source_key';

const scored = [];
const now = Date.now();
for (let from = 0; from < 1_000_000; from += 1000) {
  const { data, error } = await supabase.from('canonical_projects').select(COLS).range(from, from + 999);
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  for (const r of data ?? []) {
    const a = signals.get(r.account_key) ?? { key_account: false, key_account_score: null };
    const v = scorePriority({ ...r, key_account: a.key_account, key_account_score: a.key_account_score }, config, now);
    scored.push({ score: v.score, band: v.band, type: r.record_type, source: r.source_key, contact: r.contact_status });
  }
  if (!data || data.length < 1000) break;
}

const n = scored.length;
const scores = scored.map((s) => s.score).sort((a, b) => a - b);
const pct = (p) => scores[Math.min(n - 1, Math.floor(p * n))];

console.log(`\n${n} records scored`);
console.log(`  min ${scores[0]}  p25 ${pct(0.25)}  median ${pct(0.5)}  p75 ${pct(0.75)}  p90 ${pct(0.9)}  p95 ${pct(0.95)}  p99 ${pct(0.99)}  max ${scores[n - 1]}`);

console.log('\nDistribution (10-point buckets)');
const buckets = new Array(11).fill(0);
for (const s of scores) buckets[Math.min(10, Math.floor(s / 10))]++;
const widest = Math.max(...buckets);
buckets.forEach((count, i) => {
  if (count === 0) return;
  const bar = '#'.repeat(Math.max(1, Math.round((count / widest) * 44)));
  console.log(`  ${String(i * 10).padStart(3)}-${String(i * 10 + 9).padEnd(3)} ${String(count).padStart(5)}  ${bar}`);
});

const bandCount = (b) => scored.filter((s) => s.band === b).length;
console.log('\nWith the current thresholds');
for (const b of ['P1', 'P2', 'P3', 'P4']) {
  const c = bandCount(b);
  console.log(`  ${b} ${String(c).padStart(5)}  ${((c / n) * 100).toFixed(1)}%`);
}

// The threshold that puts `share` of the book at or above it.
const thresholdFor = (share) => scores[Math.max(0, Math.min(n - 1, Math.floor((1 - share) * n)))];
const suggested = { P1: thresholdFor(TARGETS.P1), P2: thresholdFor(TARGETS.P2), P3: thresholdFor(TARGETS.P3) };

console.log(`\nSuggested thresholds for a ${TARGETS.P1 * 100}/${(TARGETS.P2 - TARGETS.P1) * 100}/${(TARGETS.P3 - TARGETS.P2) * 100}/${(1 - TARGETS.P3) * 100} split`);
console.log(' ', JSON.stringify(suggested));
const at = (t) => scored.filter((s) => s.score >= t).length;
console.log(`  P1 >= ${suggested.P1}: ${at(suggested.P1)}  (${((at(suggested.P1) / n) * 100).toFixed(1)}%)`);
console.log(`  P2 >= ${suggested.P2}: ${at(suggested.P2) - at(suggested.P1)}`);
console.log(`  P3 >= ${suggested.P3}: ${at(suggested.P3) - at(suggested.P2)}`);
console.log(`  P4  <  ${suggested.P3}: ${n - at(suggested.P3)}`);

console.log('\nTop of the book — what a P1 would actually be');
const top = [...scored].sort((a, b) => b.score - a.score).slice(0, 8);
for (const t of top) console.log(`  ${String(t.score).padStart(3)}  ${String(t.type).padEnd(8)} ${String(t.source).padEnd(22)} ${t.contact}`);

console.log('\nBest-scoring record per source (where the value is)');
const bySource = new Map();
for (const s of scored) if (!bySource.has(s.source) || bySource.get(s.source).score < s.score) bySource.set(s.source, s);
for (const [src, s] of [...bySource.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 10)) {
  console.log(`  ${String(s.score).padStart(3)}  ${src}`);
}

const applyArg = process.argv.indexOf('--apply');
if (applyArg !== -1) {
  const [p1, p2, p3] = (process.argv[applyArg + 1] ?? '').split(',').map(Number);
  if (![p1, p2, p3].every(Number.isFinite)) {
    console.error('\n--apply needs three numbers, e.g. --apply 58,45,30');
    process.exit(1);
  }
  const v = validatePriorityConfig({ ...config, bands: { P1: p1, P2: p2, P3: p3 } });
  if (!v.ok) {
    console.error('\nRejected:', v.error);
    process.exit(1);
  }
  const { error } = await supabase
    .from('scoring_policy')
    .upsert({ id: 'default', config: v.config }, { onConflict: 'id' });
  if (error) {
    console.error('\nSave failed:', error.message);
    process.exit(1);
  }
  console.log(`\nApplied: ${JSON.stringify(config.bands)} -> ${JSON.stringify(v.config.bands)}`);
  const band = (t) => scored.filter((s) => s.score >= t).length;
  console.log(`  P1 ${band(p1)}  P2 ${band(p2) - band(p1)}  P3 ${band(p3) - band(p2)}  P4 ${n - band(p3)}`);
  console.log('  Materialize on /control/routing to write these onto the records.');
}
