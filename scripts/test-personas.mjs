/**
 * The buying committee — against the REAL src/lib/personas.ts.
 *
 * This encodes the LDR guide, whose whole point is that ORDER matters: a list
 * of five decision makers beats twenty site engineers, so the failure that
 * costs money is a search that returns juniors first, or a list that looks
 * complete because it has eight names and contains nobody who can sign.
 *
 *   node --experimental-transform-types scripts/test-personas.mjs
 */

import {
  searchTitles, titlesFor, classifyTitle, isQualifiedTitle,
  coverageFor, playFor, BUYING_ROLES, ROLE_META, PLAY_LABELS,
} from '../src/lib/personas.ts';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const group = (n) => console.log(`\n${n}`);
const plays = Object.keys(PLAY_LABELS);

group('Search order follows the pyramid — decision makers before juniors');
{
  const t = searchTitles('data_centres');
  check('the budget owner is first', t[0] === 'Director of Construction', t[0]);
  const econ = t.indexOf('Director of Construction');
  const oper = t.indexOf('Construction Director');
  const champ = t.indexOf('Head of Digital Construction');
  const user = t.indexOf('Site Manager');
  check('economic before operational', econ < oper, `${econ} vs ${oper}`);
  check('operational before champion', oper < champ, `${oper} vs ${champ}`);
  check('champion before user', champ < user, `${champ} vs ${user}`);
  check('no duplicates', new Set(t).size === t.length);
}

group('Every play is searchable and starts with an economic buyer');
for (const p of plays) {
  const t = searchTitles(p);
  check(`${p}: has titles`, t.length > 0);
  check(`${p}: first title is an economic buyer`, titlesFor(p, 'economic').includes(t[0]), t[0]);
}

group('A title maps to the role that actually decides');
for (const [title, want] of [
  ['Director of Construction', 'economic'],
  ['VP Construction', 'economic'],
  ['Managing Director', 'economic'],
  ['Programme Director', 'operational'],
  ['Project Executive', 'operational'],
  ['Head of Digital Construction', 'champion'],
  ['BIM Director', 'champion'],
  ['Site Manager', 'user'],
  ['Project Engineer', 'user'],
  ['CISO', 'technical'],
  ['IT Director', 'technical'],
]) check(`${title} -> ${want}`, classifyTitle(title) === want, String(classifyTitle(title)));

group('Unqualified titles are refused — "only qualified titles" has to mean something');
for (const t of ['Site Operative', 'Receptionist', 'Intern', 'Accounts Payable Clerk', '', null, undefined]) {
  check(`refuses ${JSON.stringify(t)}`, !isQualifiedTitle(t), String(classifyTitle(t)));
}
check('and accepts a real one', isQualifiedTitle('Head of Capital Projects'));

group('A list is complete by SHAPE, not by count');
{
  const eightUsers = Array.from({ length: 8 }, () => ({ title: 'Site Manager' }));
  const r = coverageFor(eightUsers, 'enterprise');
  check('eight juniors is not a complete enterprise list', !r.complete);
  check('it reports the economic buyer as missing', r.missing.some((m) => m.role === 'economic'));
  check('and asks for the most decisive role first', r.missing[0].role === 'economic', r.missing[0]?.role);

  const proper = [
    { title: 'Director of Construction' }, { title: 'VP Construction' },
    { title: 'Programme Director' }, { title: 'Project Executive' },
    { title: 'BIM Director' }, { title: 'Innovation Director' },
    { title: 'Site Manager' }, { title: 'Project Manager' },
  ];
  const ok = coverageFor(proper, 'enterprise');
  check('two of each role is complete', ok.complete, JSON.stringify(ok.missing));
  check('and totals eight', ok.total === 8, String(ok.total));
}

group('Mid-market needs one of each, not two');
{
  const four = [
    { title: 'Head of Construction' }, { title: 'Programme Director' },
    { title: 'BIM Director' }, { title: 'Site Manager' },
  ];
  check('four is complete for mid-market', coverageFor(four, 'mid_market').complete);
  check('but not for enterprise', !coverageFor(four, 'enterprise').complete);
  check('enterprise targets eight', coverageFor([], 'enterprise').target === 8);
  check('mid-market targets four', coverageFor([], 'mid_market').target === 4);
}

group('An empty account reports every role missing');
{
  const r = coverageFor([], 'enterprise');
  check('nothing found', r.total === 0);
  check('four roles short', r.missing.length === 4, String(r.missing.length));
  check('not complete', !r.complete);
}

group('Records route to the right play');
for (const [vertical, icp, want] of [
  ['data_center', null, 'data_centres'],
  ['semiconductor', null, 'data_centres'],
  ['battery', null, 'bess'],
  ['mining', null, 'mining'],
  ['solar', null, 'energy'],
  ['bioenergy', null, 'energy'],
  ['nuclear', null, 'energy'],
  [null, 'tier1_gc', 'tier1_contractors'],
]) check(`${vertical ?? 'none'}/${icp ?? 'none'} -> ${want}`, playFor(vertical, icp) === want, playFor(vertical, icp));

group('Roles are ranked, and the ranking is what search order depends on');
{
  const p = BUYING_ROLES.map((r) => ROLE_META[r].priority);
  check('strictly descending', p.every((v, i) => i === 0 || p[i - 1] > v), p.join(','));
  check('economic outranks everything', ROLE_META.economic.priority === Math.max(...p));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
