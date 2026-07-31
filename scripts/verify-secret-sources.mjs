/**
 * Proves that credentials resolve from the encrypted database and from nowhere
 * else.
 *
 * The env fallback that used to back every adapter is gone, so the failure this
 * guards against is silent and expensive: a source that looks configured in
 * Settings, resolves to nothing at request time, and only surfaces as a 401
 * from a vendor mid-ingestion. Run it after any change to the secret path.
 *
 * It asserts three things per keyed source: the status the UI is shown, the
 * credentials the adapter actually receives, and that the two agree.
 *
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *     --import ./scripts/lib/register-alias.mjs \
 *     scripts/verify-secret-sources.mjs
 */

const { KEYED_SLUGS, SOURCE_SLUGS } = await import('../src/lib/sourceSlugs.ts');
const { resolveCredentials } = await import('../src/lib/adapters/credentials.ts');
const { getCredentialStatus } = await import('../src/lib/adapters/credentialStatus.ts');
const { getSecretStatuses, APP_SECRETS } = await import('../src/lib/crypto/store.ts');

let passed = 0;
let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
};

console.log('\nNo credential env var is still being read');
for (const slug of KEYED_SLUGS) {
  const info = SOURCE_SLUGS[slug];
  for (const varName of [info.envApiKey, info.envApiSecret, info.envUsername, info.envBaseUrl].filter(Boolean)) {
    check(`${varName} is absent from the environment`, !process.env[varName]?.trim(), 'still set — delete it from .env.local');
  }
}

console.log('\nEach keyed source resolves consistently');
for (const slug of KEYED_SLUGS) {
  const info = SOURCE_SLUGS[slug];
  const status = await getCredentialStatus(slug);
  const creds = await resolveCredentials(info.sourceKey, 'https://default.invalid');

  check(`${slug}: origin is never 'env'`, status.origin !== 'env');

  const complete = info.needsUsername
    ? Boolean(creds.apiKey && creds.username && creds.apiSecret)
    : Boolean(creds.apiKey);

  // The whole point: what the UI claims and what the adapter gets must match,
  // or a source is offered that then fails to authenticate.
  check(
    `${slug}: status.configured (${status.configured}) matches resolved credentials (${complete})`,
    status.configured === complete
  );

  if (complete) {
    check(`${slug}: key decrypts to a usable value`, creds.apiKey.length > 8 && !creds.apiKey.startsWith('v1:'));
    check(`${slug}: base URL resolved, not left at the default`, creds.baseUrl !== 'https://default.invalid');
  }
}

console.log('\nPlatform secrets resolve from the database');
const { statuses, tableMissing } = await getSecretStatuses();
check('app_secrets exists', !tableMissing);
for (const s of statuses.filter((x) => x.required)) {
  check(`${s.label} is stored encrypted`, s.origin === 'database', `origin is '${s.origin}'`);
}
for (const s of statuses) {
  check(`${s.label} does not resolve from env`, s.origin !== 'env', `${APP_SECRETS[s.key].envVar} is still set`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
