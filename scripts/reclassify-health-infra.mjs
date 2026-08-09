#!/usr/bin/env node
/**
 * Re-checks every record this tool labelled as health infrastructure, and clears
 * the label from the ones that no longer qualify.
 *
 *   # report only
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/reclassify-health-infra.mjs
 *
 *   # apply
 *   APPLY=1 node --env-file=.env.local --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/reclassify-health-infra.mjs
 *
 * Needed because the ingest cannot fix its own past mistakes. Once the classifier
 * is tightened, a record it should never have kept is simply no longer fetched —
 * so it sits in canonical_projects wearing a "Healthcare — …" building_type that
 * nothing will ever revisit. That is the worst state to leave it in: it still
 * looks like a construction lead to whoever opens the queue.
 *
 * Dry by default, and it only ever clears the label THIS tool wrote — the seven
 * `Healthcare — …` strings from WORK_LABEL. A record whose building_type came
 * from the publisher's own CPV description is never touched, because that value
 * is not ours to erase.
 *
 * It also never deletes a row. The notice is real and was published; it is only
 * the healthcare-construction claim about it that was wrong. Clearing the label
 * returns it to being an ordinary procurement record, which is what it always was.
 */

import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { classifyHealthInfra, WORK_LABEL } from '@/lib/healthInfra';

const apply = process.env.APPLY === '1';

if (!isSupabaseServiceConfigured()) {
  console.error('Supabase service role is not configured — run with --env-file=.env.local');
  process.exit(1);
}
const s = getServiceSupabase();

// Only labels this tool wrote. Anything else in building_type belongs to the source.
const OURS = new Set(Object.values(WORK_LABEL));

const { data, error } = await s
  .from('canonical_projects')
  .select('id, ref_code, canonical_name, description, company_name_raw, building_type, source_key')
  .in('source_key', ['find_a_tender_uk', 'contracts_finder_uk', 'austender'])
  .like('building_type', 'Healthcare%')
  .order('id', { ascending: true });

if (error) {
  console.error(error.message);
  process.exit(1);
}

console.log(`${data.length} record(s) currently labelled as health infrastructure.\n`);

const stale = [];
const foreign = [];
for (const r of data) {
  if (!OURS.has(r.building_type)) {
    // Same prefix, but not one of our strings — leave it alone.
    foreign.push(r);
    continue;
  }
  const verdict = classifyHealthInfra(r.company_name_raw, `${r.canonical_name} ${r.description ?? ''}`);
  if (!verdict.isHealthInfra) stale.push({ r, verdict });
}

if (foreign.length) {
  console.log(`${foreign.length} label(s) start with "Healthcare" but were not written by this tool — untouched.`);
}

if (stale.length === 0) {
  console.log('Every label still holds. Nothing to clear.');
  process.exit(0);
}

console.log(`${stale.length} no longer qualify:\n`);
for (const { r, verdict } of stale) {
  console.log(`  ${r.ref_code}  ${r.canonical_name.slice(0, 72)}`);
  console.log(`  ${' '.repeat(r.ref_code.length)}  was "${r.building_type}" — ${verdict.reason}`);
}

if (!apply) {
  console.log(`\n${stale.length} label(s) would be cleared. Re-run with APPLY=1 to do it.`);
  process.exit(0);
}

let cleared = 0;
for (const { r } of stale) {
  const { error: upErr } = await s.from('canonical_projects').update({ building_type: null }).eq('id', r.id);
  if (upErr) {
    console.log(`  FAILED ${r.ref_code}: ${upErr.message}`);
    continue;
  }
  cleared += 1;
}
console.log(`\n${cleared} of ${stale.length} label(s) cleared. The rows themselves are untouched.`);
