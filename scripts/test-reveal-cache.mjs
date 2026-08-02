/**
 * The Apollo reveal cache, against the real table.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-reveal-cache.mjs
 *
 * Spends no Apollo credits: it writes its own fixtures and reads them back, so
 * the only thing under test is the cache itself.
 *
 * The two behaviours that matter and are easy to get wrong:
 *
 *   1. a cached NULL is honoured. "Apollo has no address for this person" cost a
 *      credit to learn and is just as true next time. A cache that only stores
 *      hits pays that credit again on every record that meets them.
 *   2. cache hits do not consume the per-record credit cap. The cap exists to
 *      limit SPEND; letting free answers count against it would spend the budget
 *      on people already known.
 *
 * Fixtures are deleted with a read-back check. An earlier verifier in this repo
 * left rows behind and reported success, because the delete matched nothing and
 * nobody looked.
 */

import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { readRevealCache, writeRevealCache } from '@/lib/enrich/revealCache';

// Skips rather than fails without a database, so the offline suite stays green.
// The cache is a real table; there is nothing to assert about it from nowhere.
if (!isSupabaseServiceConfigured()) {
  console.log('No Supabase service role configured — skipping the reveal cache test.');
  process.exit(0);
}

const service = getServiceSupabase();

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

// Prefixed so a stray row is obviously a fixture and never mistaken for a real
// Apollo person id.
const HIT = 'zz-test-cache-hit';
const NULLED = 'zz-test-cache-null';
const ABSENT = 'zz-test-cache-absent';
const IDS = [HIT, NULLED, ABSENT];

async function cleanup() {
  await service.from('apollo_reveal_cache').delete().in('apollo_person_id', IDS);
  const { data } = await service.from('apollo_reveal_cache').select('apollo_person_id').in('apollo_person_id', IDS);
  return (data ?? []).length;
}

await cleanup();

console.log('\nWriting and reading back');
await writeRevealCache(
  HIT,
  { email: 'cache.test@example.com', fullName: 'Cache Test', phone: '+15550000', linkedinUrl: 'https://x/y' },
  'example.com'
);
// The null case: Apollo answered, and had nobody.
await writeRevealCache(NULLED, { email: null, fullName: null, phone: null, linkedinUrl: null }, 'example.com');

{
  const map = await readRevealCache(IDS);
  check('a hit comes back', map.get(HIT)?.email === 'cache.test@example.com', JSON.stringify(map.get(HIT)));
  check('with the full name', map.get(HIT)?.fullName === 'Cache Test');
  check('with the phone and linkedin', map.get(HIT)?.phone === '+15550000' && map.get(HIT)?.linkedinUrl === 'https://x/y');
  // The important one. Present-with-null-email is NOT the same as absent: it means
  // "already asked, there is nothing", and it must stop a second paid attempt.
  check('a cached null is PRESENT, not missing', map.has(NULLED), 'a null answer was not stored, so the credit will be spent again');
  check('and its email is null', map.get(NULLED)?.email === null);
  check('an id never cached is absent', !map.has(ABSENT));
}

console.log('\nUpsert replaces rather than duplicating');
await writeRevealCache(HIT, { email: 'moved@example.com', fullName: 'Cache Test', phone: null, linkedinUrl: null }, 'example.com');
{
  const { data } = await service.from('apollo_reveal_cache').select('apollo_person_id').eq('apollo_person_id', HIT);
  check('one row, not two', (data ?? []).length === 1, `${(data ?? []).length} rows`);
  const map = await readRevealCache([HIT]);
  check('and it holds the newer address', map.get(HIT)?.email === 'moved@example.com');
}

console.log('\nDegrading safely');
{
  const map = await readRevealCache([]);
  check('an empty id list returns an empty map without a query', map.size === 0);
}

console.log('\nFixture cleanup');
{
  const left = await cleanup();
  check('every fixture row is gone', left === 0, `${left} left behind`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
