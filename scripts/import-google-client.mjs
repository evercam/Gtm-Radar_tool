/**
 * Loads a Google OAuth client JSON into the encrypted secret store.
 *
 * Google hands you the credentials as a downloaded file, and retyping a
 * 35-character secret out of it into a browser field is how people end up with
 * a trailing space they cannot see. This reads the file and stores both values
 * exactly as Google wrote them — AES-256-GCM in `app_secrets`, the same place
 * and the same encryption the Settings page uses. Nothing is printed but the
 * client id.
 *
 * It also checks the redirect URIs, because a client with the wrong one is the
 * single most common reason sign-in fails, and the file says what they are.
 *
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *     --import ./scripts/lib/register-alias.mjs \
 *     scripts/import-google-client.mjs <path-to-client_secret_*.json> [app-origin]
 *
 * Delete the JSON afterwards — it is a credential sitting in Downloads.
 */

import { readFileSync } from 'node:fs';

const [, , file, origin = 'http://localhost:3000'] = process.argv;

if (!file) {
  console.error('Usage: import-google-client.mjs <client_secret_*.json> [app-origin]');
  process.exit(1);
}

let client;
try {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  client = parsed.web ?? parsed.installed ?? null;
  if (!parsed.web && parsed.installed) {
    console.error('This is a "Desktop app" OAuth client. Create a "Web application" one instead —');
    console.error('a desktop client cannot hold the redirect URI this app needs.');
    process.exit(1);
  }
} catch (e) {
  console.error(`Could not read ${file}: ${e.message}`);
  process.exit(1);
}

if (!client?.client_id || !client?.client_secret) {
  console.error('That file has no client_id / client_secret in it.');
  process.exit(1);
}

const expected = `${origin.replace(/\/$/, '')}/api/auth/google/callback`;
const configured = client.redirect_uris ?? [];

console.log(`client id : ${client.client_id}`);
console.log(`project   : ${client.project_id ?? '—'}`);
console.log(`secret    : present (${client.client_secret.length} chars)`);
console.log();

if (configured.length === 0) {
  console.log('!  This client has NO redirect URIs configured.');
  console.log('   Sign-in will fail with redirect_uri_mismatch until you add, in the');
  console.log('   Google console under Credentials → your client → Authorised redirect URIs:');
  console.log(`     ${expected}`);
} else if (!configured.includes(expected)) {
  console.log('!  None of the configured redirect URIs match this app:');
  for (const u of configured) console.log(`     configured: ${u}`);
  console.log(`     expected:   ${expected}`);
} else {
  console.log(`OK redirect URI configured: ${expected}`);
}
console.log();

const { writeSecret } = await import('../src/lib/crypto/store.ts');
const { isCryptoConfigured } = await import('../src/lib/crypto/secrets.ts');

if (!isCryptoConfigured()) {
  console.error('No encryption key available — check SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}

let failed = false;
for (const [key, value] of [
  ['google_client_id', client.client_id],
  ['google_client_secret', client.client_secret],
]) {
  const res = await writeSecret(key, value);
  console.log(`${res.ok ? 'OK  ' : 'FAIL'} ${key}: ${res.message}`);
  if (!res.ok) failed = true;
}

if (!failed) {
  console.log();
  console.log('Stored encrypted. Settings will show them as set.');
  console.log(`Now delete ${file} — it is a credential.`);
}

process.exit(failed ? 1 : 0);
