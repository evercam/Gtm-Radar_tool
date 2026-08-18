/**
 * Recompute `current_phase` for USASpending records from the dates already on them.
 *
 *   npm run backfill:usaspending           # dry run — reports, writes nothing
 *   npm run backfill:usaspending -- --apply
 *
 * WHY. Until 2026-08-17 the adapter set `current_phase` to the constant 'Awarded'
 * on every award. Every USASpending award carries a start date in the past, so
 * `arrivalFor` saw a phase claiming work had not begun beside a past start date,
 * judged them contradictory, kept the phase, and returned `on_time` — "mobilising
 * or just started". Measured before the fix: 398 of 400 sampled read `on_time` and
 * NONE was cold, including contracts whose end date had already passed.
 *
 * The adapter now derives the phase from the period of performance, so records
 * re-ingest correctly. These do not: measured 2026-08-18, 4,660 rows still carry
 * 'Awarded' while only 56 have a future start date. The old rows were fetched under
 * `Award Amount desc` and the adapter now sorts `Start Date desc`, so a future pull
 * will mostly never see them again to update them. They would keep reading `on_time`
 * and keep consuming enrichment budget indefinitely.
 *
 * Both dates are already stored, so this is a pure recompute — no API calls, no new
 * information, just applying the corrected rule to data we hold.
 *
 * Keyset paging on `id`, not `.range()`: offset paging on this table exceeds the
 * statement timeout past ~19,000 rows, which is what silently truncated the scoring
 * pass. Writes are chunked for the same reason.
 */

const APPLY = process.argv.includes('--apply');
const SOURCE_KEY = 'usaspending_gov';
const PAGE = 500;
const WRITE_CHUNK = 200;

const { getServiceSupabase } = await import('../src/lib/supabase/server.ts');
const { phaseFromPeriod } = await import('../src/lib/adapters/usaspending.ts');
const { arrivalFor, isColdArrival } = await import('../src/lib/arrival.ts');

const sb = getServiceSupabase();
const now = Date.now();

/** Every record for this source, keyset-paged. */
async function readAll() {
  const out = [];
  let after = '';
  for (let guard = 0; guard < 500; guard += 1) {
    let q = sb
      .from('canonical_projects')
      .select('id,current_phase,record_type,construction_start_date,estimated_completion_date,announced_date,bid_date,source_key')
      .eq('source_key', SOURCE_KEY)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (after) q = q.gt('id', after);
    const { data, error } = await q;
    // Throwing rather than returning what we have: a partial read would report a
    // partial backfill as a complete one, which is the bug this file exists to undo.
    if (error) throw new Error(`read failed after ${out.length} rows: ${error.message}`);
    const batch = data ?? [];
    if (batch.length === 0) break;
    out.push(...batch);
    after = String(batch[batch.length - 1].id);
    if (batch.length < PAGE) break;
  }
  return out;
}

const rows = await readAll();
console.log(`${SOURCE_KEY}: ${rows.length} records read\n`);

const changes = [];
const fromTo = {};
const verdictBefore = {};
const verdictAfter = {};
let coldBefore = 0;
let coldAfter = 0;
let noDates = 0;

for (const r of rows) {
  const want = phaseFromPeriod(r.construction_start_date, r.estimated_completion_date, now);
  const before = arrivalFor(r, undefined, now);
  const after = arrivalFor({ ...r, current_phase: want }, undefined, now);
  verdictBefore[before.verdict] = (verdictBefore[before.verdict] ?? 0) + 1;
  verdictAfter[after.verdict] = (verdictAfter[after.verdict] ?? 0) + 1;
  if (isColdArrival(r, undefined, now)) coldBefore += 1;
  if (isColdArrival({ ...r, current_phase: want }, undefined, now)) coldAfter += 1;
  if (!r.construction_start_date && !r.estimated_completion_date) noDates += 1;
  if (want !== r.current_phase) {
    changes.push({ id: r.id, phase: want });
    const k = `${r.current_phase ?? '(null)'} -> ${want}`;
    fromTo[k] = (fromTo[k] ?? 0) + 1;
  }
}

const show = (t) =>
  Object.entries(t)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');

console.log(`PHASE CHANGES: ${changes.length} of ${rows.length}`);
for (const [k, v] of Object.entries(fromTo).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(42)} ${v}`);
console.log(`\nVERDICT before: ${show(verdictBefore)}`);
console.log(`VERDICT after:  ${show(verdictAfter)}`);
console.log(`\nCOLD (no enrichment spend): ${coldBefore} -> ${coldAfter}   (+${coldAfter - coldBefore})`);
/*
  Records with neither date keep whatever phase they have. phaseFromPeriod would
  answer 'Awarded' for them, which is what they already say, so they are not
  counted as changes — but worth naming, because they are the ones this cannot help.
*/
console.log(`records with no dates at all (unchanged, unhelpable): ${noDates}`);

if (!APPLY) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply to write ${changes.length} phase updates.`);
  process.exit(0);
}

console.log(`\nAPPLYING ${changes.length} updates in chunks of ${WRITE_CHUNK}…`);
let written = 0;
for (let i = 0; i < changes.length; i += WRITE_CHUNK) {
  const chunk = changes.slice(i, i + WRITE_CHUNK);
  // Grouped by target phase so each chunk is a handful of statements rather than
  // one per row.
  const byPhase = {};
  for (const c of chunk) (byPhase[c.phase] ??= []).push(c.id);
  for (const [phase, ids] of Object.entries(byPhase)) {
    const { error } = await sb.from('canonical_projects').update({ current_phase: phase }).in('id', ids);
    if (error) {
      console.log(`  FAILED at ${written}/${changes.length}: ${error.message}`);
      console.log('  Re-run to continue — the recompute is idempotent.');
      process.exit(1);
    }
    written += ids.length;
  }
  console.log(`  ${written}/${changes.length}`);
}
console.log(`\nDone. ${written} records re-phased.`);
