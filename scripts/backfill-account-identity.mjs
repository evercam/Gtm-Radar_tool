/**
 * Re-key already-enriched records onto their domain.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/backfill-account-identity.mjs [--apply]
 *
 * `account_key` used to be a slug of whatever name the source published, so one
 * company could hold several accounts — Cleveland-Cliffs held seven. Enrichment
 * now keys on the resolved domain instead, but only for records it touches from
 * here on. This applies the same rule to rows already carrying a domain, so the
 * two do not disagree for however long a full re-enrichment takes.
 *
 * Dry-run by default. Pass --apply to write.
 */

import { getServiceSupabase } from '@/lib/supabase/server';
import { accountIdentity } from '@/lib/keyaccount';

const apply = process.argv.includes('--apply');
const service = getServiceSupabase();

const PAGE = 1000;
let from = 0;
let scanned = 0;
let changed = 0;
const merges = new Map();
/** old account_key -> new one, for the side tables keyed on it. */
const rekeyed = new Map();

for (;;) {
  // Ordered, because `.range()` without one repeats and skips rows — the reads
  // would look complete and quietly miss records.
  const { data, error } = await service
    .from('canonical_projects')
    .select('id,company_name_raw,canonical_name,company_domain,account_key')
    .not('company_domain', 'is', null)
    .order('id')
    .range(from, from + PAGE - 1);
  if (error) throw error;
  if (!data.length) break;

  for (const r of data) {
    scanned++;
    const next = accountIdentity(r.company_domain, r.company_name_raw || r.canonical_name);
    if (!next || next === r.account_key) continue;
    changed++;
    merges.set(next, (merges.get(next) ?? 0) + 1);
    if (r.account_key) rekeyed.set(r.account_key, next);
    if (apply) {
      const { error: e } = await service.from('canonical_projects').update({ account_key: next }).eq('id', r.id);
      // Loudly. A backfill that half-succeeds while reporting a clean run is
      // worse than one that stops: the keys end up in two states with no record
      // of which rows are which.
      if (e) throw new Error(`Failed to re-key ${r.id}: ${e.message}`);
    }
  }

  if (data.length < PAGE) break;
  from += PAGE;
}

/**
 * `accounts_view` is derived from canonical_projects, so it merges by itself.
 * `account_enrichment` is not — it is a real table keyed on account_key, and a
 * row left under the old slug stops matching anything. Its key_account flag
 * feeds scoring, so an orphan silently demotes the account until something
 * re-enriches it.
 */
let signals = 0;
if (apply) {
  for (const [oldKey, newKey] of rekeyed) {
    const { data: exists } = await service
      .from('account_enrichment')
      .select('account_key')
      .eq('account_key', newKey)
      .maybeSingle();
    if (exists) {
      // The parent already has its own enrichment row, which is the better of
      // the two — it was resolved against the name Apollo actually indexes.
      await service.from('account_enrichment').delete().eq('account_key', oldKey);
    } else {
      const { error: e } = await service
        .from('account_enrichment')
        .update({ account_key: newKey })
        .eq('account_key', oldKey);
      if (e) throw new Error(`Failed to re-key account_enrichment ${oldKey}: ${e.message}`);
    }
    signals++;
  }
}

console.log(`${scanned} records carry a domain; ${changed} would be re-keyed${apply ? ' (APPLIED)' : ' (dry run)'}`);
if (apply) console.log(`${signals} account_enrichment rows followed the re-key`);
const top = [...merges.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [key, n] of top) console.log(`  ${String(n).padStart(4)}  ->  ${key}`);
if (!apply && changed > 0) console.log('\nRe-run with --apply to write.');
