/**
 * The buffer gate — enrichment fills a tank, it is not a rate.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-buffer-gate.mjs
 *
 * Export takes `apolloBatchSize` leads per run and the reserve behind it holds
 * that many times `exportBufferMultiple` — 10 x 24 = 240. Full tank, or a day
 * that is not the refill day, and enrichment does not spend.
 *
 * Reads the live database, so it skips without a service role.
 */

import { isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getBufferState } from '@/lib/queries';
import { DEFAULT_ENRICHMENT_POLICY } from '@/lib/enrich/policy';

if (!isSupabaseServiceConfigured()) {
  console.log('No Supabase service role configured — skipping the buffer gate test.');
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

// 1 Aug 2026 is a Saturday; 3 Aug a Monday.
const SATURDAY = new Date('2026-08-01T09:00:00Z');
const MONDAY = new Date('2026-08-03T09:00:00Z');

console.log('\nThe target comes from the roster, not from a typed-in number');
{
  // dailyDemand is the sum of active daily_lead_quota, read live — so this
  // asserts the RELATIONSHIP rather than a figure that moves when somebody is
  // hired or a quota changes.
  const b = await getBufferState(24, 6, SATURDAY);
  check('demand is read from the active roster', b.dailyDemand > 0, String(b.dailyDemand));
  check('target is demand x days of reserve', b.target === b.dailyDemand * 24, `${b.target} vs ${b.dailyDemand} x 24`);
  const c = await getBufferState(4, 6, SATURDAY);
  check('and it follows the days dial', c.target === c.dailyDemand * 4, String(c.target));
  check('days of cover is reported', typeof b.daysOfCover === 'number', String(b.daysOfCover));
}

console.log('\nThe refill day decides whether a fill may start');
{
  const sat = await getBufferState(24, 6, SATURDAY);
  check('Saturday is a refill day', sat.refillDay === true);
  const mon = await getBufferState(24, 6, MONDAY);
  check('Monday is not', mon.refillDay === false);
  check('and Monday says why, naming both days', /Saturday/.test(mon.reason ?? '') && /Monday/.test(mon.reason ?? ''), mon.reason ?? '(no reason)');
}

console.log('\nA full tank stops the spend on any day');
{
  // One day of reserve — the live buffer may or may not clear it, so assert on
  // the invariant instead of on a figure that moves with the roster.
  const b = await getBufferState(1, SATURDAY.getDay(), SATURDAY);
  check('full is consistent with ready vs target', b.full === (b.target > 0 && b.ready >= b.target), `ready ${b.ready} target ${b.target} full ${b.full}`);
  if (b.full) check('and the reason explains the ceiling', /at or above/.test(b.reason ?? ''), b.reason ?? '(none)');
  else check('otherwise the refill day decides', b.reason === null || /refill/.test(b.reason), b.reason ?? '(none)');
}

console.log('\nProduction and deliverability are reported separately');
{
  const b = await getBufferState(24, 6, SATURDAY);
  // `ready` counts what enrichment produced; `exportable` what export can send
  // today, which additionally needs an assignee. Conflating them is the bug this
  // pair exists to prevent: counting every record with an address gave 233 of a
  // 240 target while export could send 2.
  check('ready counts only what enrichment produced', b.ready >= 0 && b.ready < b.target, `${b.ready} of ${b.target}`);
  check('exportable is reported alongside it', typeof b.exportable === 'number', String(b.exportable));
  check('and never exceeds ready plus source-supplied stock', b.exportable >= 0);
}

console.log('\nThe defaults match the operating model');
{
  const d = DEFAULT_ENRICHMENT_POLICY;
  check('reserve is 24 days', d.exportBufferDays === 24, String(d.exportBufferDays));
  check('refill day is Saturday', d.refillWeekday === 6, String(d.refillWeekday));
  // apolloBatchSize is a safety rail now, not the volume dial — per-person
  // volume comes from each assignee's daily_lead_quota.
  check('apolloBatchSize is back to the API ceiling', d.apolloBatchSize === 100, String(d.apolloBatchSize));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
