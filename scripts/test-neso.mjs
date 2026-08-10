/**
 * The grid connection queue, normalised.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-neso.mjs
 *
 * This source exists because the UK planning feeds could not name a developer.
 * PlanIt publishes 48,000 applications a month and names the APPLICANT on 1 row
 * in 200 — the rest name a planning consultant, which is the wrong company to
 * hand a rep. The TEC register names the customer on every row, and the customer
 * holds the connection agreement, so they own the asset.
 *
 * The assertions that matter here are the two that would silently bury the
 * source: the connection date is a COMPLETION date, not a start, and `Plant
 * Type` is a semicolon list where storage accompanies nearly everything.
 *
 * Fixtures are real rows, read live on 2026-08-10. Pure — no network.
 */

import { nesoTecAdapter, nesoVerticalFor, NESO_REGISTERS } from '@/lib/adapters/neso';
import { normalisePhase } from '@/lib/phase';

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

/** A real row: Hornsea 3, the largest consented project in the register. */
const HORNSEA = {
  'Project Name': 'Hornsea Power Station 3',
  'Customer Name': 'HORNSEA PROJECT THREE (UK) LIMITED',
  'Connection Site': 'Norwich Main 400kV',
  'Project Status': 'Consents Approved',
  'Plant Type': 'Energy Storage System;Wind Offshore',
  'MW Effective From': '2028-12-31',
  'Cumulative Total Capacity (MW)': '3000.0',
  'Project Number': 'PRO-001234',
  'HOST TO': 'NGET',
  'Agreement Type': 'Direct Connection',
};

console.log('Both registers are configured and distinct');
{
  check('two registers', NESO_REGISTERS.length === 2);
  check('distinct slugs', new Set(NESO_REGISTERS.map((r) => r.slug)).size === 2);
  check('distinct source keys', new Set(NESO_REGISTERS.map((r) => r.sourceKey)).size === 2);
  check('distinct CKAN resources', new Set(NESO_REGISTERS.map((r) => r.resourceId)).size === 2);
  // Crossed adapters are the failure the OCDS list already produced once.
  check('the TEC adapter carries the TEC key', nesoTecAdapter.sourceKey === 'neso_tec_register');
}

console.log('\nA row becomes a project a rep could work');
{
  const n = nesoTecAdapter.normalize(HORNSEA);
  check('the project is named', n.canonical_name === 'Hornsea Power Station 3');
  check('the developer is the company', n.company_name_raw === 'HORNSEA PROJECT THREE (UK) LIMITED');
  check('they are the asset owner', n.icp_code === 'critical_infra_owner');
  check('UK', n.bu === 'uk' && n.country_code === 'GB');
  check('capacity lands in megawatts', n.capacity_mw === 3000);
  check('no money is invented', n.estimated_value === null, 'the register publishes MW, not money');
  check('the technology is kept verbatim', n.technology_type === 'Energy Storage System;Wind Offshore');
  check('the connection site is in the description', /Norwich Main 400kV/.test(n.description));
  check('the identity is the project number', n.source_unique_id === 'PRO-001234');
  check('no contact is fabricated', n.contact_name === null && n.contact_email === null);
}

console.log('\nThe connection date is a completion, not a start');
{
  /*
    "MW Effective From" is when power must flow. Filed as a start date, every
    project would look years further out than it is — and timing is the heaviest
    weight in scoring, so that one mistake would bury the whole source.
  */
  const n = nesoTecAdapter.normalize(HORNSEA);
  check('it is the completion date', n.estimated_completion_date === '2028-12-31');
  check('it is NOT the construction start', n.construction_start_date === null);
  check('and not the announced date', n.announced_date === null);
  const blank = nesoTecAdapter.normalize({ ...HORNSEA, 'MW Effective From': '' });
  check('a missing date is null, not epoch', blank.estimated_completion_date === null);
  const junk = nesoTecAdapter.normalize({ ...HORNSEA, 'MW Effective From': 'TBC' });
  check('an unparseable date is null', junk.estimated_completion_date === null);
}

console.log('\nEvery register status maps to a phase');
{
  /*
    Three of the five were unmapped before this source existed, and unmapped
    means null — invisible to the timing score. A 2037 scoping project and a site
    breaking ground next quarter would have scored the same on the heaviest
    weight there is.
  */
  const eq = (status, phase) =>
    check(`${status.padEnd(34)} -> ${phase}`, normalisePhase(status) === phase, String(normalisePhase(status)));
  eq('Scoping', 'Planned');
  eq('Awaiting Consents', 'Permitting');
  eq('Consents Approved', 'Approved');
  eq('Under Construction/Commissioning', 'Under construction');
  eq('Built', 'Operating');
  check('none of them is unmapped', ['Scoping', 'Awaiting Consents', 'Consents Approved', 'Under Construction/Commissioning', 'Built'].every((s) => normalisePhase(s) !== null));
}

console.log('\nThe most specific technology wins, not the first listed');
{
  /*
    Plant Type is a semicolon list, and storage accompanies almost everything:
    737 rows are storage alone and another 600-odd pair it with solar or wind,
    where the wind or the solar is the thing being built. Taking the first entry
    would file two thirds of the register as battery.
  */
  check('storage alone is battery', nesoVerticalFor('Energy Storage System') === 'battery');
  check('storage + solar is solar', nesoVerticalFor('Energy Storage System;PV Array (Photo Voltaic/solar)') === 'solar');
  check('storage + wind is wind', nesoVerticalFor('Energy Storage System;Wind Onshore') === 'wind');
  check('all three is wind', nesoVerticalFor('Energy Storage System;PV Array (Photo Voltaic/solar);Wind Onshore') === 'wind');
  check('offshore wind is wind', nesoVerticalFor('Wind Offshore') === 'wind');
  check('CCGT is oil_gas', nesoVerticalFor('CCGT (Combined Cycle Gas Turbine)') === 'oil_gas');
  check('nuclear beats everything', nesoVerticalFor('Nuclear;Energy Storage System') === 'nuclear');
  check('pumped hydro is hydro', nesoVerticalFor('Pumped Storage Hydro') === 'hydro');
  check('an unknown technology is still power', nesoVerticalFor('Something New') === 'power');
  check('an empty type is power, not a crash', nesoVerticalFor(undefined) === 'power');
}

console.log('\nA row with nothing to call is not a project');
{
  // The register is clean today — 2,212 of 2,212 name a customer — but a blank
  // would otherwise become a record with no company and no project.
  const n = nesoTecAdapter.normalize({ 'Customer Name': 'ACME POWER LTD' });
  check('a nameless project falls back to the customer', n.canonical_name === 'ACME POWER LTD grid connection');
  check('and keeps the developer', n.company_name_raw === 'ACME POWER LTD');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
