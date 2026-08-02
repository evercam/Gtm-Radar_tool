/**
 * Bring the stored scoring policy up to date with the code's tables.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/sync-scoring-policy.mjs [--apply]
 *
 * `getScoringPolicies()` reads the `scoring_policy` row and falls back to the
 * code defaults only when there is no row. So once a workspace has saved a
 * policy — this one did — editing DEFAULT_PRIORITY_CONFIG changes nothing. A
 * phase-table fix in the code is inert until it is copied here.
 *
 * That had already happened: 18 phase rules added in the code were absent from
 * the stored row, leaving 679 records matching no rule and taking the
 * record-type fallback of 0.4 — a middle timing score for values like "Closed"
 * and "Idled".
 *
 * WHAT THIS TOUCHES, and nothing else:
 *
 *   phaseTiming    replaced with the code's table. Safe here because all 34
 *                  stored rules were verified byte-identical to their code
 *                  counterparts — it is an old snapshot, not an edited one. The
 *                  check runs again below and refuses to overwrite an edit.
 *   coreVerticals  additive only. Entries the workspace has that the code does
 *                  not (`procurement`) are KEPT: removing one demotes records,
 *                  and an unexplained entry is more likely a deliberate choice
 *                  than an accident.
 *
 * Deliberately NOT touched: `bands`. This workspace runs P1>=62 against the code
 * default of 75. That is a real customisation and overwriting it would reband
 * the entire table.
 *
 * Rescore afterwards — scores are stored, so nothing takes effect until
 * `scripts/rescore-all.mjs` runs.
 */

import { getServiceSupabase } from '@/lib/supabase/server';
import { DEFAULT_PRIORITY_CONFIG as D } from '@/lib/priority';
import { mergePriorityConfig } from '@/lib/priority';

const apply = process.argv.includes('--apply');
const service = getServiceSupabase();

const { data: row, error } = await service.from('scoring_policy').select('config').eq('id', 'default').maybeSingle();
if (error) {
  console.error(`Could not read scoring_policy: ${error.message}`);
  process.exit(1);
}
if (!row?.config) {
  console.log('No stored scoring policy — the code defaults are already in force. Nothing to sync.');
  process.exit(0);
}

const stored = mergePriorityConfig(row.config);

// Refuse to clobber an edited rule. If any shared rule differs, a human chose
// that weight and this script has no business overwriting it.
const codeByMatch = new Map(D.phaseTiming.map((r) => [r.match, r]));
const edited = stored.phaseTiming.filter((r) => {
  const c = codeByMatch.get(r.match);
  return c && (c.weight !== r.weight || c.label !== r.label);
});
if (edited.length) {
  console.error('Refusing to sync — these stored rules differ from the code and look deliberately edited:');
  for (const r of edited) console.error(`  ${r.match}: stored ${r.weight}/${r.label}`);
  console.error('\nReconcile them by hand, then re-run.');
  process.exit(1);
}

const storedOnlyRules = stored.phaseTiming.filter((r) => !codeByMatch.has(r.match));
const newRules = D.phaseTiming.filter((r) => !stored.phaseTiming.some((s) => s.match === r.match));
// Code order first — it is ordered deliberately, dead phases before live ones so
// "closed" is not reached by something looser. Workspace-only rules go last,
// where they cannot shadow anything.
const phaseTiming = [...D.phaseTiming, ...storedOnlyRules];

const addedVerticals = D.coreVerticals.filter((v) => !stored.coreVerticals.includes(v));
const coreVerticals = [...stored.coreVerticals, ...addedVerticals];

console.log('phase rules');
console.log(`  stored ${stored.phaseTiming.length} -> ${phaseTiming.length}`);
for (const r of newRules) console.log(`   + ${r.match.padEnd(20)} ${String(r.weight).padEnd(6)} ${r.label}`);
if (storedOnlyRules.length) {
  console.log('  kept, workspace-only:');
  for (const r of storedOnlyRules) console.log(`   = ${r.match.padEnd(20)} ${r.weight}  ${r.label}`);
}

console.log('\ncore verticals');
console.log(`  stored ${stored.coreVerticals.length} -> ${coreVerticals.length}`);
for (const v of addedVerticals) console.log(`   + ${v}`);
const codeMissing = stored.coreVerticals.filter((v) => !D.coreVerticals.includes(v));
for (const v of codeMissing) console.log(`   = ${v}   (workspace-only, kept)`);

console.log('\nleft alone');
console.log(`  bands ${JSON.stringify(stored.bands)}  (code default is ${JSON.stringify(D.bands)})`);

if (!apply) {
  console.log('\nDry run. Re-run with --apply, then run scripts/rescore-all.mjs.');
  process.exit(0);
}

const next = { ...row.config, phaseTiming, coreVerticals };
const { error: writeError } = await service
  .from('scoring_policy')
  .update({ config: next, updated_at: new Date().toISOString() })
  .eq('id', 'default');
if (writeError) {
  console.error(`\nWrite failed: ${writeError.message}`);
  process.exit(1);
}
console.log('\nWritten. Scores are STORED — run scripts/rescore-all.mjs for this to take effect.');
