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

import { readFileSync, readdirSync } from 'node:fs';
import { leadVertical, verticalCode } from '../src/lib/classify.ts';
import { VERTICALS } from '../src/lib/semantics.ts';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const group = (n) => console.log(`\n${n}`);

/*
  The migration that currently DEFINES the classifier, found rather than named.

  This used to be a hard-coded path to the migration that happened to be newest
  when the check was written, and the check only covered the three verticals that
  migration added. So it went on passing while a later rename moved the TS mirror
  and left the SQL behind — the exact drift it exists to catch, invisible because
  the file it read was frozen in the past.

  `vertical` is a STORED generated column computed by this function, so the two
  sides disagreeing is not a style problem: TypeScript would classify a new record
  one way and the database would store the other, with no type error anywhere.
*/
const verticalMigrations = readdirSync('supabase/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) =>
    readFileSync(`supabase/migrations/${f}`, 'utf8').includes('function public.lead_vertical(')
  );
const latest = verticalMigrations[verticalMigrations.length - 1];
const sql = readFileSync(`supabase/migrations/${latest}`, 'utf8');

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
check('filing', leadVertical(null, null, 'filing') === 'capital_projects');
/*
  Named `capital_projects`, not `capital_markets`, and the old name must not come
  back. It described a finance desk rather than anything Evercam sells to, and its
  code CAPM reads in finance as the Capital Asset Pricing Model. The value is a
  STORED generated column feeding `ref_code` and `org_path`, so a revert in TypeScript
  alone would silently disagree with 4,269 rows the database computes the other way —
  a split no type error would catch.
*/
check('the finance-desk name is gone', !VERTICALS.includes('capital_markets'));
check('and its code with it', !VERTICALS.map(verticalCode).includes('CAPM'));
check('nothing at all is still other', leadVertical(null, null, null) === 'other');

group('Every vertical the classifier can return is in the shared vocabulary');
{
  const produced = new Set([
    'data_center','semiconductor','battery','solar','wind','nuclear','hydro','bioenergy','pipeline',
    'coal','oil_gas','mining','steel','cement','chemicals','pharma','power','procurement',
    'construction','market_intel','capital_projects',
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

group(`The SQL migration and the TS mirror name the same things (${latest})`);
check('a migration defining lead_vertical was found', Boolean(latest), 'none matched');
// Every vertical, not the three that one migration happened to add.
for (const v of VERTICALS) {
  check(`SQL returns '${v}'`, sql.includes(`then '${v}'`), 'missing from the migration');
  check(`SQL codes '${v}' as ${verticalCode(v)}`, sql.includes(`'${verticalCode(v)}'`), 'code missing from lead_vertical_code');
}
// And nothing the SQL returns is missing from the TS vocabulary, which is the
// same drift in the opposite direction.
for (const m of sql.matchAll(/then '([a-z_]+)'/g)) {
  const v = m[1];
  check(`TS knows '${v}'`, VERTICALS.includes(v) || v === 'other', 'the SQL returns it and VERTICALS does not list it');
}
for (const needle of ['bioenerg', 'biomass', 'biogas', 'pharmaceutic', 'biotech', 'power generation', 'stadium']) {
  check(`SQL matches on "${needle}"`, sql.includes(needle), 'the TS mirror matches it but the SQL does not');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
