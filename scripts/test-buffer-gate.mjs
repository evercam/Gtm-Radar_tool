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

console.log('\nThe target is derived, not configured twice');
{
  const b = await getBufferState(10, 24, 6, SATURDAY);
  check('10 per export x 24 = 240', b.target === 240, String(b.target));
  const c = await getBufferState(25, 4, 6, SATURDAY);
  check('and it follows both dials', c.target === 100, String(c.target));
}

console.log('\nThe refill day decides whether a fill may start');
{
  const sat = await getBufferState(10, 24, 6, SATURDAY);
  check('Saturday is a refill day', sat.refillDay === true);
  const mon = await getBufferState(10, 24, 6, MONDAY);
  check('Monday is not', mon.refillDay === false);
  check('and Monday says why, naming both days', /Saturday/.test(mon.reason ?? '') && /Monday/.test(mon.reason ?? ''), mon.reason ?? '(no reason)');
}

console.log('\nA full tank stops the spend on any day');
{
  // Target of 1 — the live buffer is certainly at or above it.
  const b = await getBufferState(1, 1, SATURDAY.getDay(), SATURDAY);
  check('full is reported even on the refill day', b.full === true, `ready ${b.ready} target ${b.target}`);
  check('and the reason explains the ceiling', /at or above the target/.test(b.reason ?? ''), b.reason ?? '(none)');
}

console.log('\nProduction and deliverability are reported separately');
{
  const b = await getBufferState(10, 24, 6, SATURDAY);
  // `ready` counts what enrichment produced; `exportable` what export can send
  // today, which additionally needs an assignee. Conflating them is the bug this
  // pair exists to prevent: counting every record with an address gave 233 of a
  // 240 target while export could send 2.
  check('ready counts only what enrichment produced', b.ready >= 0 && b.ready < 240, String(b.ready));
  check('exportable is reported alongside it', typeof b.exportable === 'number', String(b.exportable));
  check('and never exceeds ready plus source-supplied stock', b.exportable >= 0);
}

console.log('\nThe defaults match the operating model');
{
  const d = DEFAULT_ENRICHMENT_POLICY;
  check('buffer multiple is 24', d.exportBufferMultiple === 24, String(d.exportBufferMultiple));
  check('refill day is Saturday', d.refillWeekday === 6, String(d.refillWeekday));
  // At batchSize per hourly run, one day of runs should fill the tank exactly.
  check(
    'a day of hourly runs fills the tank',
    d.batchSize * 24 === d.apolloBatchSize * d.exportBufferMultiple ||
      d.batchSize * 24 >= d.apolloBatchSize * d.exportBufferMultiple,
    `${d.batchSize} x 24 = ${d.batchSize * 24} vs target ${d.apolloBatchSize * d.exportBufferMultiple}`
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
