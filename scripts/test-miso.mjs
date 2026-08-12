/**
 * The MISO interconnection queue adapter.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-miso.mjs
 *
 * `normalize` is pure, so most of this needs no network. Fixtures are shaped from
 * the live feed, which was characterised before the adapter was written: 3,806
 * active requests, fuel types led by Solar 1,764 / Battery Storage 736 / Wind 521,
 * study phases from "Study Not Started" through GIA.
 *
 * The assertion that matters most is the vertical/label agreement. The NESO adapter
 * shipped with a working verticalFor() that nothing called, and 331 battery
 * projects landed as `other` — the classifier reads project_type, so the label has
 * to carry the vertical or the mapping is decoration.
 */

import { misoQueueAdapter, misoVerticalFor } from '@/lib/adapters/miso';
import { SOURCE_SLUGS } from '@/lib/sourceSlugs';
import { SOURCE_CATALOG } from '@/lib/sourceCatalog';

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

const row = (over = {}) => ({
  projectNumber: 'J4183',
  queueDate: '2025-10-07T01:41:17+00:00',
  inService: '2027-04-28T04:00:00+00:00',
  transmissionOwner: 'ENTERGY MISSISSIPPI, LLC.',
  county: 'Warren',
  state: 'MS',
  studyPhase: 'Phase 1',
  studyCycle: 'DPP-2025',
  studyGroup: 'South',
  summerNetMW: 99.9,
  winterNetMW: 99.9,
  fuelType: 'Solar',
  ...over,
});

console.log('Fuel types map to this app’s verticals');
{
  check('Solar', misoVerticalFor('Solar') === 'solar');
  check('Wind', misoVerticalFor('Wind') === 'wind');
  check('Battery Storage', misoVerticalFor('Battery Storage') === 'battery');
  check('Nuclear', misoVerticalFor('Nuclear') === 'nuclear');
  check('Gas', misoVerticalFor('Gas') === 'oil_gas');
  check('Combined Cycle is gas', misoVerticalFor('Combined Cycle') === 'oil_gas');
  check('Waste Heat Recovery is bioenergy', misoVerticalFor('Waste Heat Recovery') === 'bioenergy');

  /*
    Hybrid is solar-plus-storage in nearly every row of this queue, and is mapped to
    battery on purpose: the storage half is the part with a construction programme.
    372 rows, so this is not an edge case.
  */
  check('Hybrid is battery, not solar', misoVerticalFor('Hybrid') === 'battery');

  // 253 rows arrive with the field blank. `other` would make them invisible to
  // every scope; `power` is the honest generic.
  check('a blank fuel type is power, not other', misoVerticalFor('') === 'power');
  check('null is power', misoVerticalFor(null) === 'power');
}

console.log('\nThe label carries the vertical, or the mapping is decoration');
{
  const cases = [
    ['Solar', 'solar', 'Solar farm'],
    ['Battery Storage', 'battery', 'Battery storage'],
    ['Wind', 'wind', 'Wind farm'],
    ['Nuclear', 'nuclear', 'Nuclear plant'],
  ];
  for (const [fuel, vertical, label] of cases) {
    const out = misoQueueAdapter.normalize(row({ fuelType: fuel }));
    check(`${fuel} → project_type "${label}"`, out.project_type === label, out.project_type);
    check(`  and the label names its vertical`, label.toLowerCase().includes(vertical.split('_')[0]), `${label} vs ${vertical}`);
  }
}

console.log('\nA queue request becomes a findable project');
{
  const out = misoQueueAdapter.normalize(row());
  check('the name says what, where and which queue', out.canonical_name === 'Solar farm — Warren, MS (MISO J4183)', out.canonical_name);
  check('the queue number is the dedupe key', out.source_unique_id === 'J4183');
  check('it is a usa project', out.bu === 'usa' && out.country_code === 'US');
  check('capacity lands in MW', out.capacity_mw === 99.9);
  check('the study phase is passed through verbatim', out.current_phase === 'Phase 1', out.current_phase);
  check('the queue date is when it was announced', out.announced_date === '2025-10-07', out.announced_date);
  check('in-service is the completion target', out.estimated_completion_date === '2027-04-28', out.estimated_completion_date);
  check('county and state are kept', out.city === 'Warren' && out.state_province === 'MS');
  check('the raw fuel type is preserved', out.technology_type === 'Solar');
  check('no contact is invented', out.contact_name === null && out.contact_email === null);
}

console.log('\nThe utility is not passed off as the developer');
{
  const out = misoQueueAdapter.normalize(row());
  check('the utility fills the company', out.company_name_raw === 'ENTERGY MISSISSIPPI, LLC.');
  /*
    The one thing a rep must not be allowed to assume. MISO does not publish the
    interconnection customer, so the company on this record owns the wires, not the
    project — and the description has to say so or the call opens wrong.
  */
  check('and the description says it is the transmission owner', /transmission owner, not the project developer/.test(out.description), out.description.slice(0, 160));
  check('it is classed as infrastructure ownership', out.icp_code === 'critical_infra_owner');
}

console.log('\nDates that are not schedules are rejected');
{
  const bad = misoQueueAdapter.normalize(row({ inService: '0202-05-14T00:00:00Z' }));
  check('a year-0202 target is dropped', bad.estimated_completion_date === null, String(bad.estimated_completion_date));
  const none = misoQueueAdapter.normalize(row({ inService: null, queueDate: null }));
  check('nulls stay null', none.estimated_completion_date === null && none.announced_date === null);
  const junk = misoQueueAdapter.normalize(row({ queueDate: 'not a date' }));
  check('unparseable stays null', junk.announced_date === null);
}

console.log('\nMissing pieces degrade rather than throw');
{
  const bare = misoQueueAdapter.normalize({ projectNumber: 'J1', summerNetMW: 5 });
  check('a near-empty row still normalises', typeof bare.canonical_name === 'string' && bare.canonical_name.includes('J1'), bare.canonical_name);
  check('no place still gives a name', !bare.canonical_name.includes('—'), bare.canonical_name);
  check('and the company is null, not empty string', bare.company_name_raw === null);
  check('completeness is scored, not assumed', typeof bare.source_completeness_score === 'number');
}

console.log('\nThe source is registered in both directions');
{
  // A source built and tested but missing from SOURCE_SLUGS is invisible to the
  // scheduler — that happened to news-search, which worked and never ran.
  check('the slug is registered', SOURCE_SLUGS['miso-queue']?.sourceKey === 'miso_interconnection_queue');
  const entry = SOURCE_CATALOG.find((s) => s.slug === 'miso-queue');
  check('and it appears in the catalog', Boolean(entry), 'missing from SOURCE_CATALOG');
  check('with the key the adapter writes', entry?.sourceKey === misoQueueAdapter.sourceKey, `${entry?.sourceKey} vs ${misoQueueAdapter.sourceKey}`);
  check('and is marked keyless', entry?.auth === 'keyless' && SOURCE_SLUGS['miso-queue']?.keyless === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
