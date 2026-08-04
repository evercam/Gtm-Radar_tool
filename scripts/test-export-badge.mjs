/**
 * An exported lead says so, and says when — in the list, not just the drawer.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-export-badge.mjs
 *
 * `apollo_exported_at` was already the archive flag, but the working list only
 * ever used it as a predicate: rows were filtered on it and the value was never
 * selected, so an archived lead surfaced by `?archived=1` showed the same
 * "Assigned" badge as a live one and there was nothing to sort by. Auditing what
 * was sent, and when, meant opening records one at a time.
 *
 * Uses whatever is genuinely exported, and falls back to a temporary fixture
 * when nothing is — so it asserts the rule rather than today's data. The fixture
 * is restored whatever happens.
 */

import { isSupabaseServiceConfigured, getServiceSupabase } from '@/lib/supabase/server';
import { getRecords } from '@/lib/queries';

if (!isSupabaseServiceConfigured()) {
  console.log('No Supabase service role configured — skipping the export badge test.');
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
let fixture = null;

const { count: realExports } = await service
  .from('canonical_projects')
  .select('id', { count: 'exact', head: true })
  .not('apollo_exported_at', 'is', null);

if (!realExports) {
  const { data } = await service
    .from('canonical_projects')
    .select('id, canonical_name')
    .is('apollo_exported_at', null)
    .limit(1);
  fixture = data?.[0] ?? null;
  if (fixture) {
    console.log(`No exported leads — using "${fixture.canonical_name}" as a temporary fixture.`);
    await service
      .from('canonical_projects')
      .update({ apollo_exported_at: new Date().toISOString(), apollo_export_status: 'created' })
      .eq('id', fixture.id);
  }
}

const restore = async () => {
  if (fixture) {
    await service
      .from('canonical_projects')
      .update({ apollo_exported_at: null, apollo_export_status: null })
      .eq('id', fixture.id);
  }
};

try {
  console.log('\nThe list carries the export date');
  const archived = await getRecords({ pageSize: 100, includeExported: true, sort: 'exported' });
  const exported = archived.rows.filter((r) => r.apollo_exported_at);
  check('at least one exported row is visible', exported.length > 0, `${archived.rows.length} rows, none exported`);
  check(
    'the row carries the date, not just the flag',
    exported.every((r) => !Number.isNaN(new Date(r.apollo_exported_at).getTime())),
    'a row has an unparseable apollo_exported_at'
  );
  check(
    'the row carries the outcome, so a failed send is distinguishable',
    exported.every((r) => 'apollo_export_status' in r)
  );

  console.log('\nsort=exported orders by handover, newest first');
  const dates = exported.map((r) => new Date(r.apollo_exported_at).getTime());
  check(
    'never ascending',
    dates.every((d, i) => i === 0 || d <= dates[i - 1]),
    dates.join(' ')
  );
  // The reason this sort exists: an unexported row above the newest handover
  // would make the audit view useless.
  const firstUnexported = archived.rows.findIndex((r) => !r.apollo_exported_at);
  check(
    'no null export date sorts above a real one',
    firstUnexported === -1 || archived.rows.slice(firstUnexported).every((r) => !r.apollo_exported_at),
    `row ${firstUnexported} is unexported but rows below it are exported`
  );

  console.log('\nArchiving still holds');
  const working = await getRecords({ pageSize: 100 });
  check(
    'the working list still excludes exported leads',
    working.rows.every((r) => !r.apollo_exported_at),
    'an archived lead leaked back into the default list'
  );
  check('and it is not empty, so the check above means something', working.rows.length > 0);
} finally {
  await restore();
  if (fixture) console.log(`\nRestored "${fixture.canonical_name}".`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
