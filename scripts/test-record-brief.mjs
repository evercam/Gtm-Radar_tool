/**
 * The brief carries the whole record, and says so honestly when it does not.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-record-brief.mjs
 *
 * The export sent seven summary fields out of 95 populated columns. The omissions
 * were not marginal — `description` is on 100% of export-shaped records,
 * priority on 100%, `project_url` (the link to the source) on 58% — so a rep had
 * to come back to the tool for any question the summary did not answer.
 *
 * What is asserted here is mostly about NOT lying: a sparse record must not
 * render padded with "unknown", a section with no data must disappear rather than
 * appear empty, and jsonb must not leak as jsonb.
 *
 * Pure: no database, no network.
 */

import { renderRecordBrief, BRIEF_MAX_CHARS } from '@/lib/export/recordBrief';

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

const full = {
  canonical_name: 'New River Chamber at Montgomery Locks',
  ref_code: 'USA-PROC-US-7FA612FB',
  description: 'A new river chamber at an operating lock and dam.',
  project_type: 'Federal construction award',
  building_type: 'Lock and dam',
  current_phase: 'Awarded',
  project_url: 'https://www.usaspending.gov/award/CONT_AWD_W911WN24C8011',
  estimated_value: 893_700_000,
  capacity_mw: null,
  address_line1: null,
  city: null,
  state_province: 'PA',
  country: 'US',
  announced_date: '2024-09-26T00:00:00.000Z',
  construction_start_date: '2024-09-26T00:00:00.000Z',
  company_name_raw: 'Trumbull Corporation',
  company_website: 'http://www.trumbullcorp.com',
  icp_fit_score: 92,
  icp_fit_reason: 'Massive heavy-civil megaproject.',
  evercam_timing: 'reach_now',
  trigger_event: 'Contract awarded and mobilising.',
  opening_hook: 'With the chamber now awarded to your JV…',
  value_angle: 'evidence',
  pain_point: 'Claims exposure on water-based work.',
  call_prep_summary: 'Lead on verified progress evidence.',
  priority_score: 69,
  priority_band: 'P1',
  priority_reasons: ['awarded', '894M USD', 'strategic ICP'],
  committee_coverage: { size: 'enterprise', total: 7, target: 8, complete: false, missing: [{ need: 2, role: 'economic' }, { need: 2, role: 'champion' }] },
  contact_name: 'Jeffrey Kichman',
  contact_title: 'Superintendent',
  contact_email: 'jeffrey.kichman@trumbullcorp.com',
  contact_phone: '+14128072000',
  contact_linkedin_url: 'http://www.linkedin.com/in/jeffrey-kichman',
  email_verified: true,
  phone_verified: true,
  additional_contacts: [{ name: 'Jw Houser', title: 'Superintendent', email: 'jw.houser@trumbullcorp.com' }],
  source_key: 'usaspending_gov',
  vertical: 'procurement',
  bu: 'usa',
  enriched_at: '2026-08-03T10:00:00.000Z',
};

console.log('Everything we hold reaches the brief');
{
  const b = renderRecordBrief(full, full.contact_email);
  for (const [what, needle] of [
    ['the description', 'A new river chamber at an operating lock'],
    ['the source link', 'usaspending.gov/award'],
    ['the priority score and band', '69 (P1)'],
    ['a priority reason', '894M USD'],
    ['the value, humanised', '$894M'],
    ['the location', 'PA, US'],
    ['the announced date', '2024-09-26'],
    ['the ICP verdict', 'ICP fit 92/100'],
    ['the trigger', 'Contract awarded and mobilising'],
    ['the opening line', 'With the chamber now awarded'],
    ['the call prep', 'verified progress evidence'],
    ['the committee member', 'Jw Houser'],
    ['the vertical', 'procurement'],
    ['the ref code', 'USA-PROC-US-7FA612FB'],
  ]) check(`carries ${what}`, b.includes(needle), needle);

  check('marks which committee member this contact is', /← this contact/.test(b));
  check('states verification rather than implying it', /email verified/.test(b));
}

console.log('\njsonb is rendered, never dumped');
{
  const b = renderRecordBrief(full);
  // The defect this catches: coverage came out as `{"user":7,...}` and
  // `[{"need":2,"role":"economic"}]` — every fact present, none of it readable.
  check('no raw JSON braces leak into the brief', !/\{"|"\}|\[\{/.test(b), b.match(/.{0,40}(\{"|\[\{).{0,40}/)?.[0]);
  check('coverage reads as a sentence', /Coverage: 7 of 8 contacts/.test(b), b.match(/Coverage:.*/)?.[0]);
  check('missing roles are named', /still needs 2 economic, 2 champion/.test(b), b.match(/Coverage:.*/)?.[0]);
  check(
    'a complete committee says complete',
    /complete$/m.test(renderRecordBrief({ ...full, committee_coverage: { total: 8, target: 8, complete: true } }))
  );
}

console.log('\nA sparse record is short, not padded');
{
  const bare = renderRecordBrief({ canonical_name: 'Just A Name' });
  check('renders at all', bare.includes('JUST A NAME'));
  check('no empty WHY NOW section', !bare.includes('WHY NOW'), bare);
  check('no empty TIMING section', !bare.includes('TIMING'), bare);
  check('no empty COMMITTEE section', !bare.includes('COMMITTEE'), bare);
  check('no empty PRIORITY section', !bare.includes('PRIORITY'), bare);
  check('never invents "unknown"', !/unknown/i.test(bare), bare);
  check('stays short', bare.length < 200, `${bare.length} chars`);
}

console.log('\nSections appear only when they have content');
{
  const noDates = renderRecordBrief({ ...full, announced_date: null, construction_start_date: null, estimated_completion_date: null, bid_date: null });
  check('TIMING disappears with no dates', !noDates.includes('TIMING'));
  check('but the rest survives', noDates.includes('THE PROJECT'));
  // "Remote: no" is noise; only a true flag earns a line.
  check('a false remote flag prints nothing', !renderRecordBrief({ ...full, is_remote_location: false }).includes('remote'));
  check('a true remote flag prints', renderRecordBrief({ ...full, is_remote_location: true }).includes('remote'));
}

console.log('\nA contact with no email still appears — phone-only people are real');
{
  const b = renderRecordBrief({ ...full, additional_contacts: [{ name: 'Bill C', title: 'Project Superintendent', phone: '+14128072000' }] });
  check('a phone-only committee member is listed', b.includes('Bill C'));
  check('and their phone is shown', b.includes('+14128072000'));
}

console.log('\nApollo’s field limit is respected, and truncation is admitted');
{
  const huge = renderRecordBrief({ ...full, description: 'x '.repeat(30_000) });
  check('never exceeds the field limit', huge.length <= BRIEF_MAX_CHARS, `${huge.length}`);
  check('says it was truncated', /truncated/.test(huge));
  const b = renderRecordBrief(full);
  check('a real brief is nowhere near the limit', b.length < 6000, `${b.length} chars`);
}

console.log('\nIt does not throw on the shapes the database really produces');
{
  let threw = null;
  try {
    renderRecordBrief({});
    renderRecordBrief({ priority_reasons: 'a single string' });
    renderRecordBrief({ priority_reasons: null });
    renderRecordBrief({ committee_coverage: [] });
    renderRecordBrief({ committee_coverage: 'nonsense' });
    renderRecordBrief({ additional_contacts: null });
    renderRecordBrief({ additional_contacts: 'not an array' });
    renderRecordBrief({ announced_date: 'not a date' });
    renderRecordBrief({ estimated_value: 0 });
  } catch (e) {
    threw = e;
  }
  check('every degenerate shape renders', threw === null, threw?.message);
  check('an unparseable date is passed through, not blanked', renderRecordBrief({ announced_date: 'not a date' }).includes('not a date'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
