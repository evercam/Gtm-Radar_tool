/**
 * The monthly production gate.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-production-gate.mjs
 *
 * The target is a FLOW — enriched leads produced per calendar month — not a stock
 * level. A stock rule ("hold N and stop") starves a team that consumes daily: it
 * stops producing the moment the shelf looks full and never accounts for what was
 * taken off it. 7,200 a month against five people drawing 250 a day is level.
 *
 * Reads the live database, so it skips without a service role.
 */

import { isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getProductionState } from '@/lib/queries';
import { DEFAULT_ENRICHMENT_POLICY } from '@/lib/enrich/policy';

if (!isSupabaseServiceConfigured()) {
  console.log('No Supabase service role configured — skipping the production gate test.');
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

console.log('\nThe target is a month of production, counted from the 1st');
{
  const st = await getProductionState(7200);
  check('target is what was asked for', st.target === 7200, String(st.target));
  check('produced is counted, not guessed', st.produced >= 0, String(st.produced));
  check('remaining closes the gap', st.remaining === Math.max(0, st.target - st.produced), String(st.remaining));
  check('progress is a fraction', st.progress >= 0 && st.progress <= 1, String(st.progress));
}

console.log('\nA met target stops the spend');
{
  // Zero means "no ceiling configured" and must never block.
  const none = await getProductionState(0);
  check('a zero target does not block', none.reason === null, none.reason ?? '');

  // A target of 1 is certainly met by this month's production.
  const met = await getProductionState(1);
  check('a met target blocks', met.produced >= 1 ? met.reason !== null : true, met.reason ?? '(none)');
  if (met.reason) {
    check('and says the month is done rather than failing', /target of/.test(met.reason) && /paused/.test(met.reason), met.reason);
  }
}

console.log('\nStock is reported beside flow, never instead of it');
{
  const st = await getProductionState(7200);
  // `ready` is unsold stock, `exportable` what export could send today. Both
  // answer a different question from `produced`, and conflating any two of them
  // is how a full shelf gets mistaken for a met target — the exact mistake an
  // earlier version of this gate made, reporting 233 of 240 while export could
  // send 2.
  check('ready is reported', typeof st.ready === 'number', String(st.ready));
  check('exportable is reported', typeof st.exportable === 'number', String(st.exportable));
  check('neither is negative', st.ready >= 0 && st.exportable >= 0);
  /*
    Cover is drawn from ASSIGNABLE stock, not from ready.

    This asserted ready/dailyDemand and failed on live data at 317/110 vs 2.3.
    The code is the correct one: `assignable` is unassigned stock that some
    person's scope actually covers, plus what is already assigned, and it
    excludes `unassignableReady` — leads sitting in the table that no roster
    scope can be given. Counting those as cover is the same class of mistake the
    comment above describes, a full shelf read as a met target, one step further
    on: runway that no one can draw from is not runway.

    The assertion was never run, so it kept a stale model of the metric while the
    metric moved on.
  */
  check('unassignable ready stock is reported separately', typeof st.unassignableReady === 'number', String(st.unassignableReady));
  check(
    'cover is consistent with assignable stock and the roster draw rate',
    st.dailyDemand === 0 ? st.daysOfCover === 0 : Math.abs(st.daysOfCover - st.assignable / st.dailyDemand) < 0.2,
    `${st.assignable} assignable / ${st.dailyDemand} vs ${st.daysOfCover} (ready ${st.ready}, unassignable ${st.unassignableReady})`
  );
}

console.log('\nThe defaults match the operating model');
{
  const d = DEFAULT_ENRICHMENT_POLICY;
  check('monthly target is 7,200', d.monthlyReadyTarget === 7200, String(d.monthlyReadyTarget));
  // Volume per person comes from each assignee's daily_lead_quota; this is only
  // a rail against a misconfigured quota, and Apollo caps a batch at 100 anyway.
  check('apolloBatchSize is the API ceiling, not the volume dial', d.apolloBatchSize === 100, String(d.apolloBatchSize));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
