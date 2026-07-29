/**
 * Vertical classification — the TS mirror, checked against the SQL it mirrors.
 *
 * `vertical` is a generated column computed by lead_vertical() in Postgres.
 * src/lib/classify.ts reimplements it for records that never touch the
 * database (stateless /api/search results), so the two must agree: if they
 * drift, a record classifies one way in search and another once ingested, and
 * nothing reports the discrepancy.
 *
 * They drifted here — three source categories had no bucket, so 755 records
 * (12% of the table) landed in 'other' and were invisible to every vertical
 * filter, including the enrichment policy's.
 *
 *   node --experimental-transform-types scripts/test-vertical.mjs
 */

import { readFileSync } from 'node:fs';
import { leadVertical, verticalCode } from '../src/lib/classify.ts';
import { VERTICALS } from '../src/lib/semantics.ts';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const group = (n) => console.log(`\n${n}`);

const sql = readFileSync('supabase/migrations/20260728120000_vertical_bioenergy_pharma.sql', 'utf8');

group('The categories that were falling through now classify');
check('Global Bioenergy Power Tracker', leadVertical('Global Bioenergy Power Tracker') === 'bioenergy', leadVertical('Global Bioenergy Power Tracker'));
check('Pharmaceutical / Biotech', leadVertical('Pharmaceutical / Biotech') === 'pharma', leadVertical('Pharmaceutical / Biotech'));
check('Power Generation', leadVertical('Power Generation') === 'power', leadVertical('Power Generation'));
check('Stadium / Arena', leadVertical('Stadium / Arena') === 'construction', leadVertical('Stadium / Arena'));

group('Order matters — bioenergy must win over generic power');
check('"Bioenergy Power Tracker" is bioenergy, not power', leadVertical('Bioenergy Power Tracker') === 'bioenergy');
check('biomass', leadVertical('Biomass Plant') === 'bioenergy');
check('biogas', leadVertical('Biogas Facility') === 'bioenergy');
check('a plain power plant is still power', leadVertical('Power Plant') === 'power');
check('geothermal reads as power', leadVertical('Geothermal Station') === 'power');

group('Nothing that used to classify has changed');
for (const [text, want] of [
  ['Data Center', 'data_center'], ['Semiconductor Fab', 'semiconductor'],
  ['EV / Battery Gigafactory', 'battery'], ['Solar Farm', 'solar'], ['Wind Farm', 'wind'],
  ['Nuclear Plant', 'nuclear'], ['Hydro Dam', 'hydro'], ['Gas Pipeline', 'pipeline'],
  ['Coal Mine', 'coal'], ['Mining Operations', 'mining'], ['Steel Mill', 'steel'],
  ['Cement Works', 'cement'], ['Chemicals Plant', 'chemicals'],
]) check(`${text} -> ${want}`, leadVertical(text) === want, leadVertical(text));

group('Record-type fallbacks still apply when the text says nothing');
check('tender', leadVertical(null, null, 'tender') === 'procurement');
check('permit', leadVertical(null, null, 'permit') === 'construction');
check('news', leadVertical(null, null, 'news') === 'market_intel');
check('filing', leadVertical(null, null, 'filing') === 'capital_markets');
check('nothing at all is still other', leadVertical(null, null, null) === 'other');

group('Every vertical the classifier can return is in the shared vocabulary');
{
  const produced = new Set([
    'data_center','semiconductor','battery','solar','wind','nuclear','hydro','bioenergy','pipeline',
    'coal','oil_gas','mining','steel','cement','chemicals','pharma','power','procurement',
    'construction','market_intel','capital_markets',
  ]);
  const missing = [...produced].filter((v) => !VERTICALS.includes(v));
  check('VERTICALS covers everything classifiable', missing.length === 0, missing.join(', '));
}

group('Every vertical has a distinct short code');
{
  const codes = VERTICALS.map(verticalCode);
  const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
  check('no duplicate codes', dupes.length === 0, dupes.join(', '));
  check('none fell back to OTHR', !codes.includes('OTHR'), VERTICALS.filter((v) => verticalCode(v) === 'OTHR').join(', '));
  check('codes are four characters', codes.every((c) => c.length === 4));
}

group('The SQL migration and the TS mirror name the same things');
for (const v of ['bioenergy', 'pharma', 'power']) {
  check(`SQL returns '${v}'`, sql.includes(`then '${v}'`), 'missing from the migration');
  check(`SQL codes '${v}' as ${verticalCode(v)}`, sql.includes(`'${verticalCode(v)}'`), 'code missing from lead_vertical_code');
}
for (const needle of ['bioenerg', 'biomass', 'biogas', 'pharmaceutic', 'biotech', 'power generation', 'stadium']) {
  check(`SQL matches on "${needle}"`, sql.includes(needle), 'the TS mirror matches it but the SQL does not');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
