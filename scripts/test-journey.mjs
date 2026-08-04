/**
 * The lead journey funnel says something true.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-journey.mjs
 *
 * The funnel used to report current occupancy under funnel labels, which is two
 * different questions wearing one set of numbers. It produced "Enriched 0" sitting
 * directly above "Assigned 3" — leads that could not possibly have been assigned
 * without being enriched first — and it ended in CONTACTED and CONVERTED, two
 * statuses nothing in this app ever writes, so they read 0 forever.
 *
 * These are the invariants that make the panel readable. They run against the real
 * table, because the bug was never in the arithmetic — it was in what the numbers
 * were counting.
 */

import { isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getKpiSummary } from '@/lib/kpi';
import { JOURNEY_STAGES } from '@/lib/lifecycle';

if (!isSupabaseServiceConfigured()) {
  console.log('No Supabase service role configured — skipping the journey test.');
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

// A wide window, so the assertions see the whole table rather than a quiet week.
const kpi = await getKpiSummary({ days: 3650 });

if (kpi.tableMissing) {
  console.log('canonical_projects is missing — run the migrations first.');
  process.exit(1);
}

const path = kpi.funnel.filter((f) => f.status !== 'LOST');
const lost = kpi.funnel.find((f) => f.status === 'LOST');

console.log(`\nJourney over ${kpi.total.toLocaleString()} records`);
for (const f of kpi.funnel) {
  console.log(`  ${f.status.padEnd(20)} reached ${String(f.reached).padStart(7)}   here now ${String(f.count).padStart(7)}`);
}

console.log('\nShape');
check('the funnel is the journey vocabulary, in order', path.map((f) => f.status).join(',') === JOURNEY_STAGES.join(','));
check(
  'no stage nothing can ever write',
  !kpi.funnel.some((f) => f.status === 'CONTACTED' || f.status === 'CONVERTED'),
  'CONTACTED/CONVERTED are never written by this app'
);
check('the handover to Apollo is a stage', path.some((f) => f.status === 'EXPORTED'));

console.log('\nReached is a funnel');
check(
  'never increases down the path',
  path.every((f, i) => i === 0 || f.reached <= path[i - 1].reached),
  path.map((f) => `${f.status}=${f.reached}`).join(' ')
);
check('every record reached RAW', path[0].reached === kpi.total, `${path[0].reached} vs ${kpi.total}`);
check(
  'no stage claims more records than exist',
  path.every((f) => f.reached <= kpi.total)
);

console.log('\nOccupancy is a partition');
const here = kpi.funnel.reduce((sum, f) => sum + f.count, 0);
check('every record is somewhere, exactly once', here === kpi.total, `${here} vs ${kpi.total}`);
check(
  'a stage never holds more than reached it',
  path.every((f) => f.count <= f.reached),
  path.filter((f) => f.count > f.reached).map((f) => f.status).join(',')
);

console.log('\nThe two questions stay distinct');
// The original bug in one assertion: anything downstream of a stage proves that
// stage was reached, so `reached` cannot collapse to `count`.
const downstreamOf = (i) => path.slice(i + 1).reduce((sum, f) => sum + f.count, 0);
check(
  'reached accounts for everything downstream',
  path.every((f, i) => f.reached >= f.count + downstreamOf(i)),
  path.filter((f, i) => f.reached < f.count + downstreamOf(i)).map((f) => f.status).join(',')
);
check(
  'exported leads are not also counted as sitting with a seller',
  (path.find((f) => f.status === 'EXPORTED')?.count ?? 0) === kpi.export.exported,
  `EXPORTED here-now ${path.find((f) => f.status === 'EXPORTED')?.count} vs ${kpi.export.exported} exported`
);

console.log('\nLOST is off the path');
check('it is reported, not ordered into the funnel', Boolean(lost) && !JOURNEY_STAGES.includes('LOST'));
check('its reached figure is its own count, not a cumulative one', lost.reached === lost.count);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
