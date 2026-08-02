/**
 * Find records whose contact name and contact email describe different people.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/repair-contact-pairs.mjs [--apply]
 *
 * `planEnrichmentApply` used to fill the five contact columns independently, so
 * a record holding a name from one run could take an address from another run's
 * person. That is fixed going forward; this finds the rows already written that
 * way.
 *
 * The check is deliberately conservative — it only flags a pair where the local
 * part of the address cannot be reconciled with the stored name at all. A
 * mismatch it is unsure about is left for a human, because "wrong" here means
 * deleting a real contact.
 *
 * Dry-run by default. With --apply it clears the NAME and TITLE, not the
 * address: the address is verified and provably belongs to somebody, while the
 * name is the field that is provably wrong. Re-enrichment then refills the
 * block as a unit.
 */

import { getServiceSupabase } from '@/lib/supabase/server';

const apply = process.argv.includes('--apply');
const service = getServiceSupabase();

/** Tokens a person's name contributes to an email local part. */
function nameTokens(name) {
  return name
    .toLowerCase()
    .replace(/\*/g, '')
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Words that make a local part a ROLE address rather than a person's. A role
 * address belongs to nobody in particular, so it cannot contradict a name.
 */
const ROLE_WORDS =
  /info|sales|contact|admin|hello|enquir|support|office|clerk|commercial|contract|procure|tender|planning|accounts|finance|careers|jobs|press|media|general|reception|help|team|mail/;

/**
 * Could this address plausibly belong to this person?
 *
 * Deliberately generous, because the cost of the two errors is not symmetric:
 * a missed mismatch leaves one bad row for a human to spot, while a false
 * positive deletes a real contact's name.
 *
 * Corporate addresses truncate heavily — Imane Elmajdoubi is `ielmaj@`, Victoria
 * Clarke is `victorcl@`, Blair Jackson is `bjackso3@`. A first pass demanding a
 * whole name token inside the local part flagged all three as wrong. So a
 * PREFIX of a name token counts, which is what truncation actually produces.
 */
function plausible(name, email) {
  const local = email.split('@')[0].toLowerCase();
  const alpha = local.replace(/[^a-z]/g, '');
  if (ROLE_WORDS.test(alpha)) return true;

  const tokens = nameTokens(name);
  if (tokens.length === 0) return true; // nothing to compare against

  return tokens.some((t) => {
    if (alpha.includes(t)) return true;
    // Four characters is the shortest prefix that is still distinctive; below
    // that, initials and common syllables match almost anything.
    for (let len = Math.min(t.length, 8); len >= 4; len--) {
      if (alpha.includes(t.slice(0, len))) return true;
    }
    return false;
  });
}

const PAGE = 1000;
let from = 0;
let scanned = 0;
const bad = [];

for (;;) {
  const { data, error } = await service
    .from('canonical_projects')
    .select('id,canonical_name,company_name_raw,contact_name,contact_email,contact_title')
    .not('contact_name', 'is', null)
    .not('contact_email', 'is', null)
    .order('id')
    .range(from, from + PAGE - 1);
  if (error) throw error;
  if (!data.length) break;

  for (const r of data) {
    scanned++;
    if (!plausible(r.contact_name, r.contact_email)) bad.push(r);
  }
  if (data.length < PAGE) break;
  from += PAGE;
}

console.log(`${scanned} records carry both a name and an address; ${bad.length} do not agree\n`);
for (const r of bad) {
  console.log(`  ${(r.company_name_raw || r.canonical_name || '').slice(0, 36).padEnd(36)} ${r.contact_name}  <>  ${r.contact_email}`);
}

if (bad.length && apply) {
  for (const r of bad) {
    const { error } = await service
      .from('canonical_projects')
      .update({ contact_name: null, contact_title: null })
      .eq('id', r.id);
    if (error) throw new Error(`Failed to clear ${r.id}: ${error.message}`);
  }
  console.log(`\nCleared the name and title on ${bad.length} record(s). Re-enrich to refill them as a unit.`);
} else if (bad.length) {
  console.log('\nRe-run with --apply to clear the mismatched name and title.');
}
