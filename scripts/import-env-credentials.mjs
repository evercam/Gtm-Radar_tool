/**
 * Moves every API key still living in an environment variable into the
 * encrypted store, then reports what is left behind.
 *
 * Settings has a button that does the same thing, but this cannot only be a UI
 * action: reaching Settings requires being signed in, and an upgrade that has
 * just removed the env fallback may have taken Google sign-in's own
 * credentials out of play. Running this first is the safe order.
 *
 * Both halves run, because the two stores are separate:
 *   - `app_secrets`        platform keys (Anthropic, Apollo, Google, …)
 *   - `source_credentials` the four keyed adapters (Glenigan, Barbour, …)
 *
 * Idempotent. A secret already in the database is skipped, never overwritten —
 * so re-running this can't let a forgotten variable clobber a rotated key.
 *
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *     --import ./scripts/lib/register-alias.mjs \
 *     scripts/import-env-credentials.mjs
 *
 * Once it reports clean, delete the imported variables from .env.local.
 */

const { importEnvSecrets, importEnvSourceCredentials, getSecretStatuses } = await import(
  '../src/lib/crypto/store.ts'
);
const { isCryptoConfigured } = await import('../src/lib/crypto/secrets.ts');

if (!isCryptoConfigured()) {
  console.error('No encryption key available — check SUPABASE_SECRET_KEY in .env.local.');
  process.exit(1);
}

let failed = false;

function report(title, res) {
  console.log(title);
  if (res.imported.length) console.log(`  imported  ${res.imported.join(', ')}`);
  if (res.skipped.length) console.log(`  skipped   ${res.skipped.length} already stored`);
  if (res.errors.length) {
    for (const e of res.errors) console.log(`  FAIL      ${e}`);
    failed = true;
  }
  if (!res.imported.length && !res.errors.length) console.log('  nothing found in the environment');
  console.log();
}

report('Platform secrets (app_secrets)', await importEnvSecrets());
report('Source credentials (source_credentials)', await importEnvSourceCredentials());

// Anything still reporting origin 'env' resolves to nothing now that the
// fallback is gone, so it is worth naming explicitly rather than leaving the
// operator to discover it from a failing adapter.
const { statuses, tableMissing } = await getSecretStatuses();
if (tableMissing) {
  console.log('app_secrets is missing — run the encrypted_secrets migration.');
  process.exit(1);
}

const stranded = statuses.filter((s) => s.origin === 'env');
if (stranded.length) {
  console.log('Still only in the environment — import did not take:');
  for (const s of stranded) console.log(`  ${s.label}`);
  failed = true;
} else {
  console.log('No platform secret resolves from the environment any more.');
}

process.exit(failed ? 1 : 0);
