/**
 * Retry-After parsing — run against the REAL src/lib/adapters/types.ts.
 *
 * Every free source we pull from signals throttling with 429, and Find a
 * Tender and Socrata document a Retry-After alongside it. Getting this wrong
 * is expensive in both directions: ignore the header and we hammer a provider
 * that just asked us to stop; trust it blindly and one hostile or buggy value
 * parks an ingest run for hours. So the rule is: honour what we understand,
 * cap what we honour, fall back to backoff for everything else.
 *
 *   node --experimental-transform-types scripts/test-retry-after.mjs
 */

import { parseRetryAfter } from '../src/lib/adapters/types.ts';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}
const group = (n) => console.log(`\n${n}`);

const NOW = Date.parse('2026-07-27T12:00:00Z');

group('Delay-seconds form');
check('a plain integer is seconds', parseRetryAfter('5', NOW) === 5000);
check('zero is honoured, not treated as absent', parseRetryAfter('0', NOW) === 0);
check('surrounding whitespace is tolerated', parseRetryAfter('  3  ', NOW) === 3000);
check('the 30s cap is inclusive', parseRetryAfter('30', NOW) === 30000);

group('HTTP-date form');
check('a future date becomes a delay', parseRetryAfter('Mon, 27 Jul 2026 12:00:10 GMT', NOW) === 10000);
check('a past date is ignored', parseRetryAfter('Mon, 27 Jul 2026 11:59:00 GMT', NOW) === null);
check('the current instant is ignored', parseRetryAfter('Mon, 27 Jul 2026 12:00:00 GMT', NOW) === null);

group('A run is never parked for longer than it can absorb');
check('31s exceeds the cap', parseRetryAfter('31', NOW) === null);
check('an hour is refused', parseRetryAfter('3600', NOW) === null);
check('a far-future date is refused', parseRetryAfter('Tue, 28 Jul 2026 12:00:00 GMT', NOW) === null);
check('a huge value does not overflow into a valid delay', parseRetryAfter('999999999999', NOW) === null);

group('Anything we do not understand falls back to backoff');
check('an absent header', parseRetryAfter(null, NOW) === null);
check('an empty header', parseRetryAfter('', NOW) === null);
check('whitespace only', parseRetryAfter('   ', NOW) === null);
check('a word', parseRetryAfter('soon', NOW) === null);
check('a negative number', parseRetryAfter('-5', NOW) === null);
check('a decimal is not a valid delay-seconds', parseRetryAfter('2.5', NOW) === null);
check('a number with a unit', parseRetryAfter('5s', NOW) === null);
check('a garbage date', parseRetryAfter('Not, 99 Xxx 2026', NOW) === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
