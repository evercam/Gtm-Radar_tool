/**
 * The lead spreadsheet: column mapping, date boundaries, and the summary.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-lead-report.mjs
 *
 * The boundary is the part worth testing rather than eyeballing. "Give me the
 * 10th" turning into "00:00 on the 10th only" is the classic off-by-a-day in
 * every report like this, and it fails silently: you get a smaller number that
 * looks plausible.
 */

import { toReportRow, exclusiveEnd, buildSummary, REPORT_ROW_CAP } from '@/lib/reports/leadReport';

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

console.log('An inclusive end DAY covers the whole day');
{
  check('the 10th ends at the start of the 11th', exclusiveEnd('2026-08-10') === '2026-08-11T00:00:00.000Z', exclusiveEnd('2026-08-10'));
  // Month and year rollovers, because adding a day by string arithmetic breaks here.
  check('a month rolls over', exclusiveEnd('2026-08-31') === '2026-09-01T00:00:00.000Z', exclusiveEnd('2026-08-31'));
  check('a year rolls over', exclusiveEnd('2026-12-31') === '2027-01-01T00:00:00.000Z', exclusiveEnd('2026-12-31'));
  check('a leap day rolls over', exclusiveEnd('2028-02-28') === '2028-02-29T00:00:00.000Z', exclusiveEnd('2028-02-28'));
}

console.log('\nA row carries what somebody needs to make the call');
{
  const r = toReportRow({
    canonical_name: 'Delta Blues Advanced Power Station',
    company_name_raw: 'Entergy Mississippi LLC',
    vertical: 'procurement',
    bu: 'usa',
    estimated_value: 1_200_000,
    estimated_value_currency: 'USD',
    estimated_completion_date: '2028-06-30T00:00:00Z',
    priority_band: 'P1',
    priority_score: 87,
    contact_email: 'someone@entergy.com',
    email_verified: true,
    contact_phone: '+1 555 010 2030',
    additional_contacts: [{ name: 'a' }, { name: 'b' }],
    owner_assigned_at: '2026-08-10T06:51:22.123456+00:00',
    apollo_exported_at: '2026-08-10T07:02:00+00:00',
  });

  check('the project name survives', r.Project === 'Delta Blues Advanced Power Station');
  check('value is readable, with its currency', r.Value === 'USD 1,200,000', r.Value);
  check('a date becomes a day', r.Completion === '2028-06-30', r.Completion);
  check('a timestamp becomes minutes, no T', r['Assigned at (UTC)'] === '2026-08-10 06:51', r['Assigned at (UTC)']);
  check('the export stamp too', r['Exported at (UTC)'] === '2026-08-10 07:02', r['Exported at (UTC)']);
  check('the committee is counted', r['Extra contacts'] === 2);
  check('a verified email reads yes', r['Email verified'] === 'yes');

  /*
    Blank is not "no". A contact nobody has checked and a contact that failed
    verification are different facts, and collapsing them would have somebody
    trust an address that was never tested.
  */
  const unchecked = toReportRow({ contact_email: 'x@y.com' });
  check('an unchecked email is blank, not "no"', unchecked['Email verified'] === '', `got "${unchecked['Email verified']}"`);
  const failedCheck = toReportRow({ contact_email: 'x@y.com', email_verified: false });
  check('a failed check reads no', failedCheck['Email verified'] === 'no');

  // Missing everything must not throw — most columns are null on most rows.
  const empty = toReportRow({});
  check('an empty record maps without throwing', typeof empty.Project === 'string' && empty.Project === '');
  check('and gives every column', Object.keys(empty).length === 40, String(Object.keys(empty).length));
  check('a null value is blank, not "USD null"', empty.Value === '', empty.Value);
  check('and a missing committee is zero', empty['Extra contacts'] === 0);
}

console.log('\nThe summary states the shape of the answer');
{
  const row = (band, vertical, exportedAt) => ({
    ...toReportRow({ priority_band: band, vertical, apollo_exported_at: exportedAt, contact_email: 'a@b.com' }),
  });
  const rows = [
    row('P1', 'procurement', '2026-08-10T07:00:00Z'),
    row('P1', 'procurement', '2026-08-10T07:01:00Z'),
    row('P2', 'hydro', null),
  ];
  const flat = buildSummary(rows, { owner: 'Jose Sanchez', from: '2026-08-10', to: '2026-08-10', truncated: false })
    .map((r) => r.join('='))
    .join('\n');

  check('the owner is named', /Owner=Jose Sanchez/.test(flat), flat.split('\n')[0]);
  check('a single day reads as one range', /2026-08-10 to 2026-08-10/.test(flat));
  check('the count is right', /^Leads=3$/m.test(flat), flat);
  check('exported and not are split', /Exported to Apollo=2/.test(flat) && /Not yet exported=1/.test(flat), flat);
  check('bands are tallied', /P1=2/.test(flat) && /P2=1/.test(flat));
  check('verticals are tallied', /procurement=2/.test(flat) && /hydro=1/.test(flat));

  /*
    A capped sheet must say so ON the sheet. A truncated report that looks
    complete is the exact failure this codebase keeps turning up — the Apollo
    export reporting success after sending 393 of 548 was the same shape.
  */
  const capped = buildSummary(rows, { owner: 'X', truncated: true }).map((r) => r.join('=')).join('\n');
  check('truncation is stated on the sheet', /WARNING=Capped at/.test(capped), capped);
  check('and names the cap', capped.includes(REPORT_ROW_CAP.toLocaleString()));
  check('an untruncated sheet carries no warning', !/WARNING/.test(flat));

  // Zero rows is a real answer, not an error — nobody was given anything that day.
  const none = buildSummary([], { owner: 'X', from: '2026-08-10', to: '2026-08-10', truncated: false })
    .map((r) => r.join('='))
    .join('\n');
  check('an empty result still summarises', /^Leads=0$/m.test(none), none);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
