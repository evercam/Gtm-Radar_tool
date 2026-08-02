/**
 * An exported lead is archived — everywhere, not by luck.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-archive.mjs
 *
 * `apollo_exported_at` is the archive flag. Once set, the lead has been handed
 * to Apollo and must never again be enriched, counted as ready stock, or shown
 * in the working list.
 *
 * Before this it was true only by ACCIDENT: the enrichment queue happened to skip
 * exported leads because `onlyMissingContact` filtered anything with a contact,
 * and that is a policy flag an admin can turn off — at which point we would have
 * paid to enrich leads that had already left the building. The
 * `onlyMissingContact: false` case below is the one that matters.
 *
 * Uses its own fixture rather than whatever happens to be exported today, so it
 * asserts the rule instead of the current data.
 */

import { isSupabaseServiceConfigured, getServiceSupabase } from '@/lib/supabase/server';
import { getEnrichmentQueue, getRecords, getProductionState } from '@/lib/queries';

if (!isSupabaseServiceConfigured()) {
  console.log('No Supabase service role configured — skipping the archive test.');
  process.exit(0);
}

let passed = 0,
  failed = 0;
const check = (n, c, d) => {
  if (c) {
    passed++;
    console.log(`  PASS ${n}`);
  } else {
    failed++;
    console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`);
  }
};

const service = getServiceSupabase();

// A real unexported, enriched, contactable lead — then archive it and prove it
// disappears from every working read. Restored at the end whatever happens.
const { data: candidates } = await service
  .from('canonical_projects')
  .select('id, canonical_name, apollo_exported_at, apollo_export_status')
  .not('enriched_at', 'is', null)
  .not('contact_email', 'is', null)
  .is('apollo_exported_at', null)
  .order('id')
  .limit(1);

const subject = candidates?.[0];
if (!subject) {
  console.log('No enriched, contactable, unexported lead to test with — skipping.');
  process.exit(0);
}

async function setExported(at) {
  const { error } = await service
    .from('canonical_projects')
    .update({ apollo_exported_at: at, apollo_export_status: at ? 'created' : null })
    .eq('id', subject.id);
  if (error) throw new Error(`Could not set the fixture: ${error.message}`);
}

const inQueue = async (onlyMissingContact) => {
  const q = await getEnrichmentQueue({ onlyMissingContact, limit: 500 });
  return q.rows.some((r) => r.id === subject.id);
};
const readyCount = async () => (await getProductionState(1_000_000)).ready;

try {
  console.log(`\nSubject: ${subject.canonical_name ?? subject.id}`);

  const readyBefore = await readyCount();
  check('starts out counted as ready stock', readyBefore > 0, String(readyBefore));
  // Baselines, because other leads are already archived — asserting an absolute
  // difference of one would only hold on a database with none.
  const listedBefore = (await getRecords({ sort: 'newest', pageSize: 1 })).total;

  console.log('\nOnce exported, it leaves every working read');
  await setExported(new Date().toISOString());

  check('gone from the enrichment queue', !(await inQueue(true)));
  // The one that used to pass by accident.
  check('still gone with onlyMissingContact OFF', !(await inQueue(false)));
  check('no longer counted as ready stock', (await readyCount()) === readyBefore - 1, `was ${readyBefore}`);

  const def = await getRecords({ sort: 'newest', pageSize: 1 });
  const all = await getRecords({ sort: 'newest', pageSize: 1, includeExported: true });
  check('the default list drops exactly this one', def.total === listedBefore - 1, `${listedBefore} -> ${def.total}`);
  check('and includeExported still counts every record', all.total > def.total, `${def.total} vs ${all.total}`);

  console.log('\nA FAILED export does not archive');
  await setExported(null);
  await service.from('canonical_projects').update({ apollo_export_status: 'failed' }).eq('id', subject.id);
  // NOT via the enrichment queue: `onlyMissingContact` excludes anything that
  // already has a contact, export or no export, so its absence there proves
  // nothing about archiving. Ready stock and the records list are the reads that
  // actually distinguish the two.
  check('a failed send is counted as ready again', (await readyCount()) === readyBefore, String(await readyCount()));
  check(
    'and is back in the default records list',
    (await getRecords({ sort: 'newest', pageSize: 1 })).total === listedBefore,
    `${(await getRecords({ sort: 'newest', pageSize: 1 })).total} vs ${listedBefore}`
  );
} finally {
  // Restore, and read back — a fixture left behind here would permanently
  // archive somebody's live lead.
  await service
    .from('canonical_projects')
    .update({ apollo_exported_at: subject.apollo_exported_at, apollo_export_status: subject.apollo_export_status })
    .eq('id', subject.id);
  const { data: after } = await service
    .from('canonical_projects')
    .select('apollo_exported_at, apollo_export_status')
    .eq('id', subject.id)
    .maybeSingle();
  check(
    'fixture restored exactly',
    after?.apollo_exported_at === subject.apollo_exported_at &&
      after?.apollo_export_status === subject.apollo_export_status,
    JSON.stringify(after)
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
