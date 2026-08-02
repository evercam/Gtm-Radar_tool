/**
 * Account identity — the key that decides which records are the same company.
 *
 *   node --experimental-transform-types --import ./scripts/lib/register-alias.mjs \
 *        scripts/test-account-identity.mjs
 *
 * The cases below are the real Cleveland-Cliffs rows in canonical_projects. Under
 * name-slug keying they produced up to eleven separate accounts for one company;
 * they must now produce one.
 */

import { accountIdentity, accountKey } from '../src/lib/keyaccount.ts';

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

console.log('\nOne company, eleven ways of writing it');
const CLIFFS = [
  ['clevelandcliffs.com', 'Cleveland-Cliffs Inc'],
  ['clevelandcliffs.com', 'Cleveland Cliffs Inc'],
  ['clevelandcliffs.com', 'Hibbing Taconite Co'],
  ['clevelandcliffs.com', 'Tilden Mining Company LC'],
  ['clevelandcliffs.com', 'United Taconite LLC'],
  ['clevelandcliffs.com', 'Northshore Mining Company'],
  ['clevelandcliffs.com', 'Cleveland-Cliffs Minorca Mine Inc'],
  ['clevelandcliffs.com', 'Empire Iron Mining Partnership'],
];
const keys = new Set(CLIFFS.map(([d, n]) => accountIdentity(d, n)));
check('all collapse to one key', keys.size === 1, `got ${[...keys].join(', ')}`);
check('and that key is the domain', keys.has('clevelandcliffs.com'));
// The thing being fixed: the old function saw seven different companies. It
// does merge the two spellings of the parent — hyphen and space both slug to
// "cleveland-cliffs" — which is exactly why the fragmentation looked survivable.
// It is the six subsidiaries it cannot touch, and those are the majority.
const oldKeys = new Set(CLIFFS.map(([, n]) => accountKey(n)));
check('name-slug keying really did fragment them', oldKeys.size === 7, `got ${oldKeys.size}`);

console.log('\nDomain normalisation — the same company, however the domain arrives');
const same = ['clevelandcliffs.com', 'CLEVELANDCLIFFS.COM', 'www.clevelandcliffs.com', 'https://clevelandcliffs.com/careers'];
const normed = new Set(same.map((d) => accountIdentity(d, 'whatever')));
check('scheme, www, case and path all normalise away', normed.size === 1, `got ${[...normed].join(', ')}`);

console.log('\nFallback — most records never resolve a domain');
check('no domain falls back to the name slug', accountIdentity(null, 'Acme Mining Co') === accountKey('Acme Mining Co'));
check('blank domain falls back too', accountIdentity('   ', 'Acme Mining Co') === accountKey('Acme Mining Co'));
check('neither one gives null', accountIdentity(null, null) === null);
// A key with no dot is a slug, a key with a dot is a domain. Nothing else is
// allowed to look like a domain, or the two namespaces would collide.
check(
  'a domain-less string is not mistaken for a domain',
  accountIdentity('localhost', 'Acme Mining Co') === accountKey('Acme Mining Co')
);

console.log('\nDifferent companies stay different');
check(
  'two real companies do not merge',
  accountIdentity('nexteraenergy.com', 'NextEra') !== accountIdentity('fpl.com', 'FPL')
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
