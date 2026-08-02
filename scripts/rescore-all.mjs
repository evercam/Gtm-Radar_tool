/**
 * Rescore every record with the policy the workspace is actually running.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/rescore-all.mjs
 *
 * Needed after any change to the scoring policy or the phase table, because
 * scores are STORED. Nothing recomputes them on read, so a config change is
 * inert until this runs — and worse than inert, because the config and the
 * stored bands then disagree and the queue filters on the stale one.
 *
 * Why a script rather than the endpoint: a full pass over 22,990 records takes
 * several minutes and `/api/routing/apply` lives inside a 300-second function.
 * `{ scope: 'all' }` there cannot finish, so it is only safe for `unscored`.
 *
 * Retries, because the first attempt at this died on a transient `fetch failed`
 * partway through and left the table half-rescored — some rows on the new
 * config, some on the old, with nothing to say which. `rerouteAll` is idempotent
 * (it recomputes from the record, it does not accumulate), so repeating a pass
 * is always safe.
 */

import { getRoutingPolicy, rerouteAll } from '@/lib/queries';
import { getScoringPolicies } from '@/lib/policies';

const ATTEMPTS = Number(process.env.RESCORE_ATTEMPTS) || 5;

const [{ rules }, scoring] = await Promise.all([getRoutingPolicy(), getScoringPolicies()]);

// Say which policy is being applied. The stored row overrides the code defaults,
// and a run that silently used one when the operator expected the other is how
// a rescore becomes indistinguishable from a regression.
const cfg = scoring.byBu?.default ?? scoring;
console.log('Applying the STORED scoring policy:');
console.log('  bands        ', JSON.stringify(cfg.bands));
console.log('  phase rules  ', cfg.phaseTiming?.length ?? '?');
console.log('  coreVerticals', cfg.coreVerticals?.length ?? '?');
console.log('');

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const started = Date.now();
  try {
    const res = await rerouteAll(rules, scoring, { scope: 'all' });
    console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)}s on attempt ${attempt}.`);
    console.log('  scored:', res.total.toLocaleString());
    console.log('  bands :', JSON.stringify(res.byBand));
    console.log('  lanes :', JSON.stringify(res.byLane));
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Attempt ${attempt}/${ATTEMPTS} failed after ${Math.round((Date.now() - started) / 1000)}s: ${msg}`);
    if (attempt === ATTEMPTS) {
      console.error('\nGiving up. The table may be PARTIALLY rescored — run this again before trusting any band.');
      process.exit(1);
    }
    // Linear backoff. The failure mode seen was a transient connection drop, not
    // rate limiting, so there is nothing to be gained by backing off hard.
    const wait = attempt * 10_000;
    console.error(`Retrying in ${wait / 1000}s...`);
    await new Promise((r) => setTimeout(r, wait));
  }
}
