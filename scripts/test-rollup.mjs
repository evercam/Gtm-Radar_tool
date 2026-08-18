/**
 * The dashboard rollup folds — against the real src/lib/queries.ts.
 *
 * These exist for one failure, and it is a quiet one. `dashboard_rollup()` groups
 * by (bu, vertical, contact_status) AND by reachable/assigned/exported, so up to
 * EIGHT rows collapse into one key when folding back onto (bu, vertical,
 * contact_status). A fold that overwrote instead of summing would report an eighth
 * of the stock — a dashboard full of plausible, wrong, smaller numbers, which is
 * far worse than a dashboard that fails to load.
 *
 * So every case here checks that a total survives the fold. The arithmetic is the
 * whole point; there is nothing else in these functions.
 *
 *   node --experimental-transform-types scripts/test-rollup.mjs
 */

delete process.env.SUPABASE_SECRET_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;

const { foldPipelineRollup, foldBuRollup } = await import('../src/lib/queries.ts');

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
const group = (n) => console.log(`\n${n}`);

/** One aggregate row. Defaults chosen so a case states only what it is testing. */
const row = (o = {}) => ({
  bu: 'usa',
  vertical: 'construction',
  contact_status: 'none',
  reachable: false,
  assigned: false,
  exported: false,
  n: 1,
  ...o,
});

group('The eight-way split folds back to one row, with the total intact');
/*
  The exact shape the aggregate produces for a single (bu, vertical,
  contact_status): every combination of the three booleans, each with its own count.
  All eight must land on ONE row totalling 36.
*/
const eight = [
  row({ reachable: false, assigned: false, exported: false, n: 1 }),
  row({ reachable: false, assigned: false, exported: true, n: 2 }),
  row({ reachable: false, assigned: true, exported: false, n: 3 }),
  row({ reachable: false, assigned: true, exported: true, n: 4 }),
  row({ reachable: true, assigned: false, exported: false, n: 5 }),
  row({ reachable: true, assigned: false, exported: true, n: 6 }),
  row({ reachable: true, assigned: true, exported: false, n: 7 }),
  row({ reachable: true, assigned: true, exported: true, n: 8 }),
];
const folded = foldPipelineRollup(eight);
check('eight rows fold to one', folded.length === 1, `got ${folded.length}`);
// 1+2+…+8. If this reads 8, the fold is overwriting and the dashboard is showing
// an eighth of the truth.
check('the counts are SUMMED, not overwritten', folded[0]?.count === 36, `got ${folded[0]?.count}`);
check('the key fields survive', folded[0]?.bu === 'usa' && folded[0]?.vertical === 'construction');

group('Distinct keys stay distinct');
const mixed = foldPipelineRollup([
  row({ bu: 'usa', n: 10 }),
  row({ bu: 'uk', n: 20 }),
  row({ bu: 'usa', vertical: 'solar', n: 5 }),
  row({ bu: 'usa', contact_status: 'verified', n: 7 }),
]);
check('four distinct combinations stay four rows', mixed.length === 4, `got ${mixed.length}`);
check('nothing is lost across keys', mixed.reduce((n, r) => n + r.count, 0) === 42);
check('vertical is part of the key', mixed.some((r) => r.vertical === 'solar' && r.count === 5));
check('contact_status is part of the key', mixed.some((r) => r.contact_status === 'verified' && r.count === 7));

group('The BU fold and its derived columns');
const bu = foldBuRollup(eight);
const usa = bu.get('usa');
check('one BU row', bu.size === 1, `got ${bu.size}`);
check('total is the sum of all eight', usa?.total === 36, `got ${usa?.total}`);
// 5+6+7+8 — the four reachable rows.
check('reachable counts only reachable rows', usa?.reachable === 26, `got ${usa?.reachable}`);
// 3+4+7+8
check('assigned counts only assigned rows', usa?.assigned === 22, `got ${usa?.assigned}`);
// 2+4+6+8
check('exported counts only exported rows', usa?.exported === 20, `got ${usa?.exported}`);
/*
  waiting = reachable AND NOT assigned, which is rows 5 and 6 only: 5+6 = 11. This
  is the workable backlog, so overcounting it would send somebody looking for leads
  that are already owned.
*/
check('waiting is reachable and unassigned', usa?.waiting === 11, `got ${usa?.waiting}`);
check('activeAssignees is left for the caller', usa?.activeAssignees === 0);

group('A null business unit is named, not dropped');
/*
  Dropping it would make the BU totals disagree with the table total, and the
  dashboard would silently be missing stock nobody could account for.
*/
const withNull = foldBuRollup([row({ bu: null, n: 9 }), row({ bu: 'uk', n: 1 })]);
check('null becomes "unknown"', withNull.has('unknown'), [...withNull.keys()].join(','));
check('its count is kept', withNull.get('unknown')?.total === 9);
check('the totals still add up', [...withNull.values()].reduce((n, r) => n + r.total, 0) === 10);

group('Degenerate input');
check('an empty aggregate is an empty result', foldPipelineRollup([]).length === 0);
check('an empty aggregate is an empty map', foldBuRollup([]).size === 0);
check('a zero count is carried rather than dropped', foldPipelineRollup([row({ n: 0 })])[0]?.count === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
