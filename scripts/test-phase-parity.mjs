/**
 * The SQL phase mapping and the TypeScript one must agree.
 *
 * `phase_normalised` is a generated column driven by `normalise_phase()`, which is
 * emitted from src/lib/phase.ts by scripts/generate-phase-sql.mjs. Generated, so it
 * cannot be transcribed wrong — but it CAN be stale: edit a rule in phase.ts, forget
 * to regenerate, and the column keeps answering with the old mapping. Nothing about
 * that failure is visible. `search_projects` filters on the column and everything
 * else folds in TypeScript, so the two would simply disagree about which projects
 * are in a phase, quietly, in opposite directions.
 *
 * So this pins them against each other on every distinct value the table actually
 * holds — not a fixture, the real vocabulary, which is where the surprises are.
 *
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-phase-parity.mjs
 *
 * Needs a live database and the migration applied, so like test:mcp it is not part
 * of `npm test`.
 */

import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { normalisePhase } from '@/lib/phase';

if (!isSupabaseServiceConfigured()) {
  console.error('Supabase service role is not configured — run me with --env-file=.env.local');
  process.exit(1);
}

const s = getServiceSupabase();
let failed = 0;
const fail = (msg) => {
  failed += 1;
  console.log(`  FAIL ${msg}`);
};

/*
  The distinct vocabulary, via the rollup rather than a table walk.

  Reading 109k rows to collect ~143 strings times out, and the rollup already
  groups by the raw column — the values are a by-product of a query that exists.
*/
const { data: rollup, error: rollupError } = await s.rpc('pipeline_rollup');
if (rollupError) {
  console.error(`pipeline_rollup is unavailable (${rollupError.message}) — apply its migration first.`);
  process.exit(1);
}

const rawValues = [...new Set(rollup.map((r) => r.current_phase).filter((v) => v != null))];
console.log(`\nPhase mapping parity — ${rawValues.length} distinct raw values in canonical_projects\n`);

/*
  One RPC per value, ten at a time.

  The generated column is `GENERATED ALWAYS AS (normalise_phase(current_phase))`,
  so testing the function tests the column: there is no path by which they differ.
  Going through the function directly also means a value that exists in the mapping
  but not yet in the data can be checked the same way.
*/
async function sqlPhase(raw) {
  const { data, error } = await s.rpc('normalise_phase', { raw });
  if (error) throw new Error(`normalise_phase(${JSON.stringify(raw)}): ${error.message}`);
  return data ?? null;
}

const CONCURRENCY = 10;
const mismatches = [];
try {
  for (let i = 0; i < rawValues.length; i += CONCURRENCY) {
    const slice = rawValues.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map((raw) => sqlPhase(raw)));
    slice.forEach((raw, n) => {
      const sql = results[n];
      const ts = normalisePhase(raw);
      if (sql !== ts) mismatches.push({ raw, sql, ts });
    });
  }
} catch (err) {
  console.error(
    `\nCould not reach normalise_phase — is 20260818220000_phase_normalised.sql applied?\n  ${err.message}`
  );
  process.exit(1);
}

if (mismatches.length === 0) {
  console.log(`  PASS all ${rawValues.length} raw values map identically in SQL and TypeScript`);
} else {
  for (const m of mismatches) {
    fail(`${JSON.stringify(m.raw)} — sql=${JSON.stringify(m.sql)} ts=${JSON.stringify(m.ts)}`);
  }
  console.log(`\n  ${mismatches.length} value(s) disagree. Re-run scripts/generate-phase-sql.mjs and ship the migration.`);
}

/*
  Canaries for the two translations that are easy to get wrong and silent when wrong.
  Asserted directly rather than left to whether the data happens to contain a case.

  `\b` is a word boundary in JavaScript and a BACKSPACE in Postgres; the rule routing
  planning_ie's "AI" steps to Permitting depends on it. Both directions are needed,
  and only these exact values test it:

    "AI"        — reachable ONLY through \yai\y. Mistranslate the boundary and this
                  matches nothing and falls through to null. ("AI Requested" looks
                  like the obvious case and proves nothing: it also matches via
                  "request", so it passes either way.)
    "Aircraft…" — must NOT be Permitting. Drop the boundary instead of translating
                  it and "ai" matches inside "aircraft", stealing the row from
                  /construct/.

  The third is key(): trim, collapse inner whitespace, lowercase. Several planning_ie
  values differ from each other only by trailing spaces, so a regexp_replace that
  does not collapse runs would split one phase into several.
*/
console.log('\nThe fragile translations survived the trip to Postgres\n');
for (const [raw, expected] of [
  ['AI', 'Permitting'],
  ['Aircraft Hangar Construction', 'Under construction'],
  ['  Decision   Issued  ', 'Approved'],
]) {
  const sql = await sqlPhase(raw);
  const ts = normalisePhase(raw);
  if (sql === expected && ts === expected) console.log(`  PASS ${JSON.stringify(raw)} → ${expected} in both`);
  else fail(`${JSON.stringify(raw)} — expected ${expected}, sql=${JSON.stringify(sql)} ts=${JSON.stringify(ts)}`);
}

console.log(`\n${failed === 0 ? 'parity holds' : `${failed} failed`}\n`);
process.exit(failed === 0 ? 0 : 1);
