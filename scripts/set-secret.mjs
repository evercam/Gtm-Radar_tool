/**
 * Stores one platform secret from the command line.
 *
 * Settings is the normal way in, but it cannot be the ONLY way: reaching it
 * requires being signed in, signing in requires issuing a session, and issuing
 * a session requires the Supabase JWT secret. A fresh install therefore cannot
 * enter its own JWT secret through the UI. This is the way out of that, and it
 * writes to exactly the same encrypted table Settings does.
 *
 * The value is read from stdin rather than argv so it never reaches the shell
 * history or the process list.
 *
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *     --import ./scripts/lib/register-alias.mjs \
 *     scripts/set-secret.mjs supabase_jwt_secret
 *
 * Then paste the value and press Enter.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const key = process.argv[2];

const { APP_SECRETS, writeSecret } = await import('../src/lib/crypto/store.ts');
const { isCryptoConfigured } = await import('../src/lib/crypto/secrets.ts');

if (!key || !(key in APP_SECRETS)) {
  console.error('Usage: set-secret.mjs <key>\n');
  console.error('Known keys:');
  for (const [k, meta] of Object.entries(APP_SECRETS)) {
    console.error(`  ${k.padEnd(24)} ${meta.label}`);
  }
  process.exit(1);
}

if (!isCryptoConfigured()) {
  console.error('No encryption key available — check SUPABASE_SECRET_KEY in .env.local.');
  process.exit(1);
}

console.log(`${APP_SECRETS[key].label} — ${APP_SECRETS[key].description}`);
console.log();

const rl = createInterface({ input: stdin, output: stdout, terminal: true });
const value = (await rl.question(`Paste the value for ${key}: `)).trim();
rl.close();

if (!value) {
  console.error('Nothing entered — nothing written.');
  process.exit(1);
}

const res = await writeSecret(key, value);
console.log();
console.log(res.ok ? `OK   ${res.message}` : `FAIL ${res.message}`);
console.log(res.ok ? `     stored encrypted, last4 …${value.slice(-4)}` : '');
process.exit(res.ok ? 0 : 1);
