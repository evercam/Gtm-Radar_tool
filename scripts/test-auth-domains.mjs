/**
 * Domain allow-list input handling — against the REAL src/lib/auth/authSettings.ts.
 *
 * The database decides admission (see test-google-admission.sh); this decides
 * what ends up IN the list. An admin typing "@Evercam.com " or pasting a whole
 * address must not silently produce an entry that matches nobody, because the
 * failure mode is invisible: colleagues just quietly land in the pending queue.
 *
 *   node --experimental-transform-types scripts/test-auth-domains.mjs
 */

import { normalizeDomain, validateDomains } from '../src/lib/auth/authSettings.ts';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const group = (n) => console.log(`\n${n}`);

group('What an admin actually types is accepted');
check('a bare domain', normalizeDomain('evercam.com') === 'evercam.com');
check('a leading @', normalizeDomain('@evercam.com') === 'evercam.com');
check('upper case', normalizeDomain('Evercam.COM') === 'evercam.com');
check('surrounding space', normalizeDomain('  evercam.com  ') === 'evercam.com');
check('a whole address becomes its domain', normalizeDomain('jose@evercam.com') === 'evercam.com');
check('a pasted URL becomes its host', normalizeDomain('https://evercam.com/careers') === 'evercam.com');
check('a subdomain stays a subdomain', normalizeDomain('mail.evercam.com') === 'mail.evercam.com');
check('a hyphen is legal', normalizeDomain('balfour-beatty.co.uk') === 'balfour-beatty.co.uk');

group('What could never match an address is refused');
check('empty', normalizeDomain('') === null);
check('a lone @', normalizeDomain('@') === null);
check('a single label', normalizeDomain('evercam') === null, 'would silently admit nobody');
check('localhost', normalizeDomain('localhost') === null);
check('a trailing dot', normalizeDomain('evercam.com.') === null);
check('a leading dot', normalizeDomain('.evercam.com') === null);
check('a space inside', normalizeDomain('ever cam.com') === null);
check('an underscore', normalizeDomain('ever_cam.com') === null);
check('a wildcard', normalizeDomain('*.evercam.com') === null, 'the trigger does exact match, not glob');

group('The saved list');
const ok = validateDomains(['@Evercam.com', 'jose@evercam.com', ' balfour-beatty.co.uk ']);
check('valid input is accepted', ok.ok === true);
check('duplicates collapse after normalising', ok.ok && ok.domains.length === 2, JSON.stringify(ok));
check('normalised on the way in', ok.ok && ok.domains[0] === 'evercam.com');

const blanks = validateDomains(['evercam.com', '', '   ']);
check('blank entries are dropped, not rejected', blanks.ok === true && blanks.domains.length === 1);

const bad = validateDomains(['evercam.com', 'nonsense']);
check('one bad entry fails the whole save', bad.ok === false, JSON.stringify(bad));
check('and the message names the offender', !bad.ok && bad.error.includes('nonsense'));

check('an empty list is valid — it means "approve everyone by hand"',
  validateDomains([]).ok === true);
check('a non-list is refused', validateDomains('evercam.com').ok === false);
check('null is refused', validateDomains(null).ok === false);

group('Case and shape agree with the database');
// The trigger lower-cases the address domain and compares with `= any(...)`.
// Anything stored non-lower-case would match nothing, so this is the contract.
const stored = validateDomains(['EVERCAM.COM']);
check('stored lower-case, as the trigger compares', stored.ok && stored.domains[0] === 'evercam.com');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
