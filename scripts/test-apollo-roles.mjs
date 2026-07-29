/**
 * Apollo title/territory → roster defaults, against the REAL module.
 *
 * Every title below is one that actually exists in the Evercam Apollo
 * workspace — taken from the live users/search response, not invented. The
 * ordering cases are the point: "Key Account Manager" contains both "account"
 * and "manager", and matching seniority first would file every AE under
 * sales_manager, silently giving closers a manager's lead scope.
 *
 *   node --experimental-transform-types scripts/test-apollo-roles.mjs
 */

import { roleFromTitle, buFromTerritory, buFromTerritories, suggestRoster } from '../src/lib/export/apolloRoles.ts';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const group = (n) => console.log(`\n${n}`);
const is = (title, role) => check(`${title || '(blank)'} → ${role}`, roleFromTitle(title) === role, `got ${roleFromTitle(title)}`);

group('Real titles from the workspace');
is('LDR', 'bdr');
is('BDR', 'bdr');
is('Senior BDR', 'bdr');
is('Business Development Representative', 'bdr');
is('Business Development Executive', 'bdr');
is('Senior Business Development Representative', 'bdr');
is('Account Executive', 'ae');
is('Key Account Executive', 'ae');
is('Key Account Manager', 'ae');
is('Account Manager', 'ae');
is('Sales Team Lead - US', 'sales_manager');
is('Managing Director', 'sales_manager');
is('Managing Director, US', 'sales_manager');

group('Ordering — the cases that would silently mis-scope someone');
check('"Key Account Manager" is an AE, not a manager',
  roleFromTitle('Key Account Manager') === 'ae',
  'seniority matched before the IC pattern');
check('"Account Manager" is an AE',
  roleFromTitle('Account Manager') === 'ae');
check('"Sales Manager" IS leadership',
  roleFromTitle('Sales Manager') === 'sales_manager');
check('"Head of Business Development" is leadership, not a BDR',
  roleFromTitle('Head of Business Development') === 'sales_manager',
  `got ${roleFromTitle('Head of Business Development')}`);

group('Titles that imply nothing');
is('', null);
is(null, null);
is(undefined, null);
is('   ', null);
is('Gtm engineer', null);
is('BizOps Manager', null);
is('Chief of Staff', 'sales_manager');
is('Customer Success Manager', null);
is('Partnerships', null);

group('Case and spacing');
is('senior bdr', 'bdr');
is('  Account Executive  ', 'ae');
is('ACCOUNT EXECUTIVE', 'ae');

group('Territories seen in the workspace');
check('USA → usa', buFromTerritory('USA') === 'usa');
check('UK → uk', buFromTerritory('UK') === 'uk');
check('APAC → apac', buFromTerritory('APAC') === 'apac');
check('ANZ folds into apac', buFromTerritory('ANZ') === 'apac', 'this app has no ANZ unit');
check('unknown territory → null', buFromTerritory('Narnia') === null);
check('blank → null', buFromTerritory('') === null);
check('lower case matches', buFromTerritory('usa') === 'usa');

group('Several territories');
check('de-duplicated', JSON.stringify(buFromTerritories(['APAC', 'ANZ'])) === '["apac"]',
  JSON.stringify(buFromTerritories(['APAC', 'ANZ'])));
check('order preserved', JSON.stringify(buFromTerritories(['UK', 'USA'])) === '["uk","usa"]');
check('unknowns dropped, known kept', JSON.stringify(buFromTerritories(['Narnia', 'UK'])) === '["uk"]');
check('empty list', JSON.stringify(buFromTerritories([])) === '[]');
check('null', JSON.stringify(buFromTerritories(null)) === '[]');

group('The whole suggestion');
const mandy = suggestRoster({ title: 'Senior BDR', territories: ['UK'] });
check('Mandy Backstrom → bdr / uk', mandy.role === 'bdr' && mandy.bu[0] === 'uk');
check('and says why', (mandy.because ?? '').includes('Senior BDR') && (mandy.because ?? '').includes('UK'),
  mandy.because);

const kevin = suggestRoster({ title: 'Sales Team Lead - US', territories: ['USA'] });
check('Kevin Pierce → sales_manager / usa', kevin.role === 'sales_manager' && kevin.bu[0] === 'usa');

const jason = suggestRoster({ title: 'Key Account Executive', territories: ['ANZ'] });
check('Jason Hofmann → ae / apac', jason.role === 'ae' && jason.bu[0] === 'apac');

const ronald = suggestRoster({ title: null, territories: ['USA'] });
check('no title falls back to bdr', ronald.role === 'bdr');
check('but the territory is still read', ronald.bu[0] === 'usa');
check('and the reason mentions only what was known',
  (ronald.because ?? '') === 'USA', ronald.because);

const nothing = suggestRoster({});
check('nothing known → bdr, no bu, no reason',
  nothing.role === 'bdr' && nothing.bu.length === 0 && nothing.because === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
