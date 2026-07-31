/**
 * The session token — against the REAL src/lib/auth/jwt.ts.
 *
 * This file replaced Supabase Auth. Every RLS policy in the database trusts
 * the `sub` claim of whatever token arrives, so a forged token is not a
 * sign-in bug, it is read access to the whole lead book under someone else's
 * identity. The tampering cases below are the point of this file.
 *
 *   node --experimental-transform-types scripts/test-jwt.mjs
 */

import { createHmac } from 'node:crypto';

const SECRET = 'test-jwt-secret-at-least-32-chars-long!!';
process.env.SESSION_SIGNING_KEY = SECRET;

// Hermetic on purpose. `jwtSecret()` reads the encrypted store before falling
// back to the variable above, so a shell that has sourced .env.local — which is
// ordinary, `set -a; . ./.env.local` is in half the runbooks — lets the
// "without a secret" case reach the real database, find a real signing key, and
// fail a test that is asserting fail-closed behaviour. Unsetting the connection
// here means the suite tests this module rather than the operator's shell.
delete process.env.SUPABASE_SECRET_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;

const {
  issueSession, verifySession, shouldRefresh, sessionCookieOptions, randomToken,
  SESSION_COOKIE, SESSION_TTL_SECONDS, resetJwtSecretCache,
} = await import('../src/lib/auth/jwt.ts');

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const group = (n) => console.log(`\n${n}`);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (data, secret) => createHmac('sha256', secret).update(data).digest('base64url');
const forge = (claims, secret = SECRET, header = { alg: 'HS256', typ: 'JWT' }) => {
  const body = `${b64(header)}.${b64(claims)}`;
  return `${body}.${sign(body, secret)}`;
};
const now = () => Math.floor(Date.now() / 1000);
const valid = (over = {}) => ({ sub: 'a1b2c3', role: 'authenticated', aud: 'authenticated', iat: now(), exp: now() + 3600, ...over });

const USER = { id: '11111111-2222-3333-4444-555555555555', email: 'jose@evercam.com' };

group('A token this app issued is accepted');
const token = await issueSession(USER);
check('a token is produced', typeof token === 'string' && token.split('.').length === 3);
const claims = await verifySession(token);
check('it verifies', claims !== null);
check('sub is the profile id — this is what auth.uid() returns', claims?.sub === USER.id);
check('role is authenticated, so PostgREST applies the authenticated policies', claims?.role === 'authenticated');
check('aud is carried through to request.jwt.claims', claims?.aud === 'authenticated');
check('email rides along so the proxy can re-issue without a query', claims?.email === USER.email);
check('expiry is the configured TTL', Math.abs((claims?.exp ?? 0) - now() - SESSION_TTL_SECONDS) <= 2);

group('A tampered token is not');
// Mutate the FIRST signature character, not the last: base64url's final
// character carries spare bits, so several spellings decode to the same
// bytes and flipping it is not reliably a different signature.
const [h, pl, sg] = token.split('.');
check('a flipped signature is refused',
  (await verifySession(`${h}.${pl}.${(sg[0] === 'A' ? 'B' : 'A')}${sg.slice(1)}`)) === null);
check('a token signed with another secret is refused',
  (await verifySession(forge(valid(), 'a-different-secret-entirely-32-chars'))) === null,
  'this is the whole security boundary');
check('an unsigned token is refused', (await verifySession(`${b64({ alg: 'none' })}.${b64(valid())}.`)) === null);
check('alg:none WITH a valid signature is still refused',
  (await verifySession(forge(valid(), SECRET, { alg: 'none', typ: 'JWT' }))) === null,
  'alg must be checked, not trusted');
check('HS512 is refused even though it is symmetric',
  (await verifySession(forge(valid(), SECRET, { alg: 'HS512', typ: 'JWT' }))) === null);
check('an empty string is refused', (await verifySession('')) === null);
check('null is refused', (await verifySession(null)) === null);
check('undefined is refused', (await verifySession(undefined)) === null);
check('two segments are refused', (await verifySession('a.b')) === null);
check('four segments are refused', (await verifySession('a.b.c.d')) === null);
check('a garbage payload is refused', (await verifySession(`${b64({ alg: 'HS256' })}.!!!notbase64!!!.${sign('x', SECRET)}`)) === null);
check('a shorter signature cannot pass by length', (await verifySession(token.split('.').slice(0, 2).join('.') + '.abc')) === null);

group('Claims that would widen access are refused');
check('an expired token', (await verifySession(forge(valid({ exp: now() - 1 })))) === null);
check('a token expiring exactly now', (await verifySession(forge(valid({ exp: now() })))) === null);
check('no expiry at all', (await verifySession(forge({ sub: 'x', role: 'authenticated', aud: 'authenticated', iat: now() }))) === null);
check('a string expiry', (await verifySession(forge(valid({ exp: String(now() + 3600) })))) === null);
check('role: service_role', (await verifySession(forge(valid({ role: 'service_role' })))) === null,
  'would bypass RLS entirely');
check('role: anon', (await verifySession(forge(valid({ role: 'anon' })))) === null);
check('role: postgres', (await verifySession(forge(valid({ role: 'postgres' })))) === null);
check('a missing role', (await verifySession(forge({ sub: 'x', aud: 'authenticated', iat: now(), exp: now() + 60 })))=== null);
check('a wrong audience', (await verifySession(forge(valid({ aud: 'anon' })))) === null);
check('an empty sub', (await verifySession(forge(valid({ sub: '' })))) === null);
check('a missing sub', (await verifySession(forge({ role: 'authenticated', aud: 'authenticated', iat: now(), exp: now() + 60 }))) === null);
check('a numeric sub', (await verifySession(forge(valid({ sub: 12345 })))) === null, 'auth.uid() casts to uuid');
check('an object sub', (await verifySession(forge(valid({ sub: { id: 'x' } })))) === null);

group('Without a secret, nothing is issued and nothing is accepted');
delete process.env.SESSION_SIGNING_KEY;
resetJwtSecretCache();
check('issuing returns null rather than an unsigned token', (await issueSession(USER)) === null);
check('a previously valid token no longer verifies', (await verifySession(token)) === null,
  'fails closed');
process.env.SESSION_SIGNING_KEY = SECRET;
resetJwtSecretCache();
check('and it works again once the secret is back', (await verifySession(token)) !== null);

group('Sliding expiry');
check('a fresh token is not refreshed', shouldRefresh(valid({ exp: now() + 8 * 3600 })) === false);
check('one inside its last hour is', shouldRefresh(valid({ exp: now() + 600 })) === true);
check('one on the boundary is not', shouldRefresh(valid({ exp: now() + 3601 })) === false);
check('an already-expired one is', shouldRefresh(valid({ exp: now() - 10 })) === true);

group('The cookie');
const opts = sessionCookieOptions(3600);
check('httpOnly — script cannot read the session', opts.httpOnly === true);
check('sameSite lax, so the return from Google still carries it', opts.sameSite === 'lax');
check('path is the whole app', opts.path === '/');
check('maxAge is passed through', opts.maxAge === 3600);
check('the name is stable', SESSION_COOKIE === 'ldr_session');

group('State tokens');
const a = randomToken(), b = randomToken();
check('two calls differ', a !== b);
check('long enough to be unguessable', Buffer.from(a, 'base64url').length >= 32);
check('URL-safe', /^[A-Za-z0-9_-]+$/.test(a));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
