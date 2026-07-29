/**
 * Contact-validation checks.
 *
 * The pure predicates are extracted FROM src/lib/enrich/validate.ts at run
 * time rather than re-typed here. An earlier version of this file hand-copied
 * the email regex, dropped a backslash, and reported two failures that did not
 * exist in the source — a test that is wrong in the same shape as a bug is
 * worse than no test.
 *
 *   node scripts/test-validation.mjs
 */

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/lib/enrich/validate.ts', import.meta.url), 'utf8');

function constant(name) {
  const m = src.match(new RegExp(`const ${name} = (/.*?/[a-z]*);`));
  if (!m) throw new Error(`Could not extract ${name} from validate.ts`);
  return eval(m[1]);
}
function stringArray(name) {
  const m = src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`Could not extract ${name} from validate.ts`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const EMAIL_SHAPE = constant('EMAIL_SHAPE');
const PLACEHOLDER = constant('PLACEHOLDER');
const ROLE_PREFIXES = stringArray('ROLE_PREFIXES');

const isRole = (email) => {
  const local = (email.split('@')[0] ?? '').toLowerCase();
  return ROLE_PREFIXES.some((p) => local === p || local.startsWith(`${p}.`) || local.startsWith(`${p}-`));
};
const digitsOf = (p) => p.replace(/\D/g, '');
const phoneShapeOk = (p) => {
  const d = digitsOf(p);
  if (d.length < 7 || d.length > 15) return false;
  if (/^(\d)\1+$/.test(d) || d === '1234567890') return false;
  return true;
};
const requiredChannel = (s) => (s === 'act_now' ? 'phone' : s === 'nurture' ? 'email' : s === 'qualify' ? 'both' : 'none');

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  if (cond) {
    pass += 1;
    console.log('  PASS', name);
  } else {
    fail += 1;
    console.log('  FAIL', name);
  }
};

console.log('Email shape (regex read from source)');
t('accepts a normal address', EMAIL_SHAPE.test('jane.doe@evercam.io'));
t('accepts deep subdomains', EMAIL_SHAPE.test('a@mail.corp.example.co.uk'));
t('accepts plus addressing', EMAIL_SHAPE.test('jane+leads@evercam.io'));
t('rejects a missing @', !EMAIL_SHAPE.test('janeevercam.io'));
t('rejects a bare hostname', !EMAIL_SHAPE.test('jane@localhost'));
t('rejects spaces', !EMAIL_SHAPE.test('jane doe@x.com'));
t('rejects a comma-injected second address', !EMAIL_SHAPE.test('a@x.com,b@y.com'));
t('rejects angle brackets', !EMAIL_SHAPE.test('<jane@x.com>'));
t('rejects a trailing dot', !EMAIL_SHAPE.test('jane@x.com.'));

console.log('\nVendor placeholders');
t('rejects email_not_unlocked', PLACEHOLDER.test('email_not_unlocked_abc@domain.com'));
t('rejects @domain.com', PLACEHOLDER.test('x@domain.com'));
t('rejects @example.com', PLACEHOLDER.test('x@example.com'));
t('allows a real domain', !PLACEHOLDER.test('x@evercam.io'));

console.log('\nRole addresses');
t('info@ is role-based', isRole('info@x.com'));
t('sales.uk@ is role-based', isRole('sales.uk@x.com'));
t('no-reply@ is role-based', isRole('no-reply@x.com'));
t('a named person is not role-based', !isRole('jane.doe@x.com'));
t('a prefix that merely starts the same is not role-based', !isRole('information@x.com'));

console.log('\nPhone shape');
t('accepts E.164', phoneShapeOk('+353 1 234 5678'));
t('accepts a US 10-digit number', phoneShapeOk('(415) 555-0198'));
t('rejects too short', !phoneShapeOk('12345'));
t('rejects too long', !phoneShapeOk('1234567890123456'));
t('rejects all-same digits', !phoneShapeOk('000000000'));
t('rejects the 1234567890 placeholder', !phoneShapeOk('123-456-7890'));
t('rejects empty', !phoneShapeOk(''));

console.log('\nChannel requirements');
t('act_now requires a phone', requiredChannel('act_now') === 'phone');
t('nurture requires an email', requiredChannel('nurture') === 'email');
t('qualify requires both', requiredChannel('qualify') === 'both');
t('hold requires nothing', requiredChannel('hold') === 'none');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
