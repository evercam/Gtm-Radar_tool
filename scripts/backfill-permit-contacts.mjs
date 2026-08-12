/**
 * Fill `contact_name` from the person already named on the permit.
 *
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/backfill-permit-contacts.mjs
 *
 *   ... scripts/backfill-permit-contacts.mjs --apply     to write
 *
 * Dry by default. Measured before writing anything: of 400 sampled permits, 96%
 * carried a usable owner name and we had stored one on 29% — so 70% arrived with a
 * named person attached to that address on that filing date, and the pipeline threw
 * it away and then paid Apollo to guess a contact by job title instead.
 *
 * Only ever fills an EMPTY contact_name. A name already on the record came from an
 * adapter that chose it deliberately, and a bulk job must not overrule that.
 *
 * The dry run reports what actually changes downstream rather than just a row
 * count, because a name on its own does not make a lead exportable — the export
 * needs a channel. The split between "has a channel, gains a name" and "has
 * neither" is the difference between leads that improve today and leads that only
 * become matchable later.
 */

import { getServiceSupabase } from '@/lib/supabase/server';
import { permitContactFrom } from '@/lib/import/permitContact';

const APPLY = process.argv.includes('--apply');
const PAGE = 1000;

const sb = getServiceSupabase();

let scanned = 0;
let extracted = 0;
let rejected = 0;
let alreadyNamed = 0;
let toFill = 0;
let withChannel = 0;
let withoutChannel = 0;
let written = 0;
let failed = 0;
const roles = { owner: 0, permittee: 0 };
const samples = [];

// Keyset on id: an offset walk over a filtered set repeats and skips rows, and a
// backfill that skips rows silently under-delivers.
let after = '';

for (let page = 0; page < 200; page += 1) {
  let q = sb
    .from('canonical_projects')
    .select('id, contact_name, contact_email, contact_phone, additional_contacts, company_name_raw, field_provenance, raw_data')
    .eq('record_type', 'permit')
    .not('raw_data', 'is', null)
    .order('id', { ascending: true })
    .limit(PAGE);
  if (after) q = q.gt('id', after);

  const { data, error } = await q;
  if (error) {
    console.error('read failed:', error.message);
    process.exit(1);
  }
  if (!data?.length) break;

  for (const row of data) {
    scanned += 1;
    const found = permitContactFrom(row.raw_data);
    if (!found) {
      rejected += 1;
      continue;
    }
    extracted += 1;
    roles[found.role] += 1;

    if (row.contact_name && String(row.contact_name).trim()) {
      alreadyNamed += 1;
      continue;
    }

    toFill += 1;
    const committee = Array.isArray(row.additional_contacts) ? row.additional_contacts.length : 0;
    if (row.contact_email || row.contact_phone || committee > 0) withChannel += 1;
    else withoutChannel += 1;

    if (samples.length < 8) {
      samples.push(`${found.name} (${found.role})${found.company ? ` — ${found.company}` : ''}`);
    }

    if (!APPLY) continue;

    /*
      Provenance alongside the name, so this is auditable later. Without it a
      permit-derived name is indistinguishable from one an adapter curated, and the
      signal scorer would have no way to weigh them differently.
    */
    const provenance = row.field_provenance && typeof row.field_provenance === 'object' ? { ...row.field_provenance } : {};
    provenance.contact_name = {
      source: 'permit_filing',
      fields: found.fields,
      role: found.role,
      at: new Date().toISOString(),
    };

    const update = { contact_name: found.name, field_provenance: provenance };
    // The permit names the business the person acts for; only fill it if empty, for
    // the same reason as the name.
    if (found.company && !row.company_name_raw) update.company_name_raw = found.company;

    const { error: writeError } = await sb.from('canonical_projects').update(update).eq('id', row.id);
    if (writeError) {
      failed += 1;
      if (failed <= 3) console.error(`  write failed for ${row.id}: ${writeError.message}`);
    } else {
      written += 1;
    }
  }

  after = data[data.length - 1].id;
  if (data.length < PAGE) break;
  if (scanned % 5000 === 0) console.log(`  … ${scanned} scanned`);
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN — nothing written'}`);
console.log(`permits scanned            : ${scanned}`);
console.log(`  person extracted         : ${extracted}  (owner ${roles.owner}, permittee ${roles.permittee})`);
console.log(`  rejected as not-a-person : ${rejected}`);
console.log(`  already had a name       : ${alreadyNamed}`);
console.log(`  WOULD FILL               : ${toFill}`);
console.log(`     of those, reachable today (has email/phone/committee): ${withChannel}`);
console.log(`     of those, no channel yet — matchable, not yet callable: ${withoutChannel}`);
if (APPLY) console.log(`  written                  : ${written}   failed: ${failed}`);
console.log('\nsamples:');
for (const s of samples) console.log('  ', s);
if (!APPLY) console.log('\nRe-run with --apply to write.');
