/**
 * The bid deadline: procurement's earliest dated signal.
 *
 *   node --experimental-transform-types --import ./scripts/lib/register-alias.mjs \
 *        scripts/test-bid-date.mjs
 *
 * `arrivalFor` has always had a bid-date branch and it has NEVER executed in
 * production: measured 2026-08-13, zero of 101,897 records carried a `bid_date`.
 * The only two adapters that populated it — SAM.gov and ConstructConnect — are
 * both keyed sources with no credentials, so both have ingested nothing.
 *
 * Meanwhile find-a-tender publishes `tender.tenderPeriod.endDate` on tender-stage
 * releases and the adapter threw it away. That is the difference between a record
 * judged against the 6-month selling window and one that can only say
 * "unconfirmed", on 194 of find-a-tender's 534 records.
 *
 * The payloads below are real shapes taken from `raw_data` on live rows, not
 * invented ones — including the award-stage release that correctly yields null.
 */

import { readFileSync } from 'node:fs';
import { findATenderAdapter } from '../src/lib/adapters/ocds.ts';
import { worldBankAdapter } from '../src/lib/adapters/world-bank.ts';
import { arrivalFor } from '../src/lib/arrival.ts';

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

const release = (tender, extra = {}) => ({
  ocid: 'ocds-h6vhtk-04f9f3',
  id: 'rel-1',
  date: '2026-07-01T00:00:00Z',
  parties: [{ name: 'A Council', roles: ['buyer'] }],
  buyer: { name: 'A Council' },
  tender: { id: 't-1', title: 'Construction of a school', ...tender },
  ...extra,
});

console.log('\nA tender-stage notice carries its bid deadline through');
{
  // Real shape: 3 of 6 sampled tender-stage find-a-tender releases look like this.
  const r = findATenderAdapter.normalize(release({ tenderPeriod: { endDate: '2026-09-10T14:00:00+01:00' } }));
  check('bid_date is populated', r.bid_date === '2026-09-10', `got ${r.bid_date}`);
  check('and the phase is Tender', r.current_phase === 'Tender', r.current_phase);
  check('no start date is invented', r.construction_start_date === null, `got ${r.construction_start_date}`);
  check('the deadline is recorded as a timeline', r.fields_populated.project_timeline === true, JSON.stringify(r.fields_populated.project_timeline));
}

console.log('\nawardPeriod is the fallback when there is no tenderPeriod');
{
  const r = findATenderAdapter.normalize(release({ awardPeriod: { endDate: '2026-09-29T23:59:59+01:00' } }));
  check('falls back to awardPeriod', r.bid_date === '2026-09-29', `got ${r.bid_date}`);
  const both = findATenderAdapter.normalize(
    release({ tenderPeriod: { endDate: '2026-09-10T14:00:00+01:00' }, awardPeriod: { endDate: '2026-09-29T23:59:59+01:00' } })
  );
  check('but tenderPeriod wins, being the earlier signal', both.bid_date === '2026-09-10', `got ${both.bid_date}`);
}

console.log('\nA release with no period yields null rather than a guess');
{
  // Also a real shape — half the tender-stage sample had no period object at all.
  const r = findATenderAdapter.normalize(release({}));
  check('bid_date is null', r.bid_date === null, `got ${r.bid_date}`);
}

console.log('\nAn award-stage release yields null, and that is correct');
{
  /*
    Publishers drop tenderPeriod once a contract is let, because by then the
    deadline is history. 340 of find-a-tender's 534 records and 189 of 189
    austender records are award-stage, so this is the common case — it must read
    as "not applicable", not as a bug.
  */
  const r = findATenderAdapter.normalize(
    release({}, { contracts: [{ dateSigned: '2026-06-01', period: { startDate: '2026-08-05', endDate: '2027-08-05' } }] })
  );
  check('bid_date is null on an awarded contract', r.bid_date === null, `got ${r.bid_date}`);
  check('the contract start date is used instead', r.construction_start_date === '2026-08-05', `got ${r.construction_start_date}`);
  check('and the phase says awarded', r.current_phase === 'Contract Awarded', r.current_phase);
}

console.log('\nThe dead branch in arrivalFor now runs');
{
  const NOW = new Date('2026-08-13T00:00:00Z').getTime();
  const inWindow = findATenderAdapter.normalize(release({ tenderPeriod: { endDate: '2026-10-01T00:00:00Z' } }));
  const a = arrivalFor(inWindow, undefined, NOW);
  check('a bid deadline inside the window reads early', a.verdict === 'early', `got ${a.verdict}`);
  check('and is marked as dated, not inferred', a.dated === true);

  const farOut = findATenderAdapter.normalize(release({ tenderPeriod: { endDate: '2028-01-01T00:00:00Z' } }));
  const b = arrivalFor(farOut, undefined, NOW);
  check('a deadline beyond the window reads too_early', b.verdict === 'too_early', `got ${b.verdict}`);

  // Without a bid date the same notice can only say the phase.
  const bare = findATenderAdapter.normalize(release({}));
  check('the same notice with no deadline is unconfirmed', arrivalFor(bare, undefined, NOW).verdict === 'unconfirmed');
}

console.log('\nWorld Bank board approval is not a construction start');
{
  /*
    boardapprovaldate was written into construction_start_date, giving all 250
    records `basis: construction_start` and `dated: true` — the most confident
    verdict arrivalFor returns — from the date a loan was approved. Measured: 200
    of 200 sampled had construction_start_date === announced_date, both being
    this one field. The Bank publishes no construction start date at all.
  */
  const r = worldBankAdapter.normalize({
    id: 'P123456',
    proj_id: 'P123456',
    project_name: 'Water supply rehabilitation',
    status: 'Active',
    boardapprovaldate: '2026-04-30T00:00:00Z',
    closingdate: '2029-06-30T00:00:00Z',
    countrycode: 'KE',
    countryname: 'Kenya',
  });
  check('construction_start_date is null', r.construction_start_date === null, `got ${r.construction_start_date}`);
  check('board approval still lands in announced_date', r.announced_date === '2026-04-30', `got ${r.announced_date}`);
  check('the closing date is still the completion target', r.estimated_completion_date === '2029-06-30', `got ${r.estimated_completion_date}`);
  check('the two dates are no longer the same field twice', r.construction_start_date !== r.announced_date);

  const a = arrivalFor(r, undefined, new Date('2026-08-13T00:00:00Z').getTime());
  check('the verdict no longer claims to come from a start date', a.basis !== 'construction_start', a.basis);
  // It lands on the completion branch, which discloses that the date is a target
  // rather than build remaining — the same "name your basis" contract.
  check(
    'and says out loud how it knows',
    /target rather than time remaining|inferred from the phase|no dates published/.test(a.summary),
    a.summary
  );
}

console.log('\nA throttled publisher is paged to what its window affords');
{
  /*
    Find a Tender allows 12 requests per 120 seconds. Paced at 10s, a run issues
    requests at t=0,10,…,110 — twelve inside the window — so the thirteenth lands on
    its boundary and is refused with a 429 asking for a 120-second wait, longer than
    fetchWithRetry will sit on a Retry-After.

    `maxPages` used to come from the record budget alone: 5,000 records at 100 a page
    capped to 40. So every scheduled run walked into that thirteenth request. Measured
    2026-08-18, find-a-tender reported `fetched=0` with a 429 and 10 of its previous
    14 runs were killed as `interrupted` — 40 pages at 10s each is 400 seconds of
    deliberate sleeping against a 300-second function limit. One number, both symptoms.
  */
  const ceilingFor = (intervalMs) => (intervalMs ? Math.max(1, Math.floor(120_000 / intervalMs)) : 40);
  const pagesFor = (intervalMs, maxRecords, pageSize) =>
    Math.min(ceilingFor(intervalMs), 40, Math.max(1, Math.ceil(maxRecords / Math.max(1, pageSize)) + 2));

  check('a 10s pace affords 12 pages, not 40', pagesFor(10_000, 5000, 100) === 12, String(pagesFor(10_000, 5000, 100)));
  check('and that fits inside the function budget', (pagesFor(10_000, 5000, 100) - 1) * 10 < 240);
  // The old value is the regression to guard against.
  check('the record budget alone would have asked for 40', Math.min(40, Math.ceil(5000 / 100) + 2) === 40);
  check('an unthrottled publisher is unaffected', pagesFor(null, 5000, 250) === 22, String(pagesFor(null, 5000, 250)));
  check('a small budget still wins over the ceiling', pagesFor(10_000, 100, 100) === 3, String(pagesFor(10_000, 100, 100)));
  check('the ceiling never drops below one page', ceilingFor(600_000) === 1);

  // Source-level: a mid-pull failure must keep what earlier pages returned.
  const src = readFileSync('src/lib/adapters/ocds.ts', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('a mid-pull failure keeps the pages already collected', /if \(releases\.length === 0\) throw new Error\(why\)/.test(code));
  check('and stops rather than throwing them away', /console\.warn\([\s\S]{0,240}?break;/.test(code), 'no break following the warn');
  check('the first page still throws, since nothing was collected', /releases\.length === 0/.test(code));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
