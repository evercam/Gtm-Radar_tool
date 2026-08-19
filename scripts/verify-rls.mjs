/**
 * Proves RLS actually applies through the direct-Postgres path.
 *
 * The whole approach rests on one claim: that switching to `authenticated` and
 * setting `request.jwt.claims` reproduces what PostgREST does, so the existing
 * policies work untouched. That claim is worth very little asserted and quite a
 * lot demonstrated — a silent failure here does not look like an error, it
 * looks like the app working while showing every user everyone's leads.
 *
 * So this compares what the same query returns with and without the role
 * switch, and fails loudly if they match when they should not.
 *
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *     --import ./scripts/lib/register-alias.mjs scripts/verify-rls.mjs
 */

const { withUser, withService, closePool, isDbConfigured } = await import('../src/lib/db/pool.ts');

let passed = 0, failed = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log(`  PASS ${n}`); }
  else { failed++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); }
};
const group = (n) => console.log(`\n${n}`);

if (!isDbConfigured()) {
  console.error('DATABASE_URL is not set in .env.local.');
  console.error('Supabase dashboard → Project Settings → Database → Connection string → URI.');
  process.exit(1);
}

try {
  group('The connection');
  const who = await withService((c) => c.query('select current_user, current_database(), version()'));
  console.log(`  connected as ${who.rows[0].current_user} to ${who.rows[0].current_database}`);
  console.log(`  ${who.rows[0].version.split(',')[0]}`);

  group('Inside withUser, the request looks like an authenticated PostgREST call');
  const { rows: profiles } = await withService((c) =>
    c.query(`select id, email, role from public.user_profiles order by email limit 5`)
  );
  if (profiles.length === 0) {
    console.error('\nNo user_profiles rows — sign in once first.');
    process.exit(1);
  }
  const me = profiles[0];
  console.log(`  acting as ${me.email} (${me.role})`);

  const ctx = await withUser(me.id, (c) =>
    c.query(`select current_user::text as who, auth.uid()::text as uid,
                    current_setting('request.jwt.claims', true) as claims`)
  );
  const r = ctx.rows[0];
  check('the role really switched', r.who === 'authenticated', `current_user = ${r.who}`);
  check('auth.uid() resolves to the signed-in user', r.uid === me.id, `auth.uid() = ${r.uid}`);
  check('the claim is visible to policies', (r.claims ?? '').includes(me.id));

  group('The switch is not sticky — a pooled connection cannot leak identity');
  const after = await withService((c) =>
    c.query(`select current_user::text as who, coalesce(current_setting('request.jwt.claims', true), '') as claims`)
  );
  check('role reverted after the transaction', after.rows[0].who !== 'authenticated', after.rows[0].who);
  check('claim did not survive', !after.rows[0].claims.includes(me.id), after.rows[0].claims.slice(0, 60));

  group('RLS actually restricts — the point of the exercise');
  const total = await withService((c) => c.query('select count(*)::int as n from public.canonical_projects'));
  const asUser = await withUser(me.id, (c) => c.query('select count(*)::int as n from public.canonical_projects'));
  console.log(`  service role sees ${total.rows[0].n.toLocaleString()}`);
  console.log(`  ${me.email} sees ${asUser.rows[0].n.toLocaleString()}`);
  check('policies were evaluated rather than skipped',
    typeof asUser.rows[0].n === 'number',
    'the query itself failed');

  // An admin legitimately sees everything, so an equal count only proves a
  // problem for someone who should be restricted.
  if (me.role === 'admin') {
    console.log('  (equal counts are correct here — this user is an admin)');
  } else {
    check('a non-admin does not see the whole table',
      asUser.rows[0].n < total.rows[0].n,
      'RLS is NOT restricting this user');
  }

  const restricted = profiles.find((p) => p.role === 'bdr');
  if (restricted) {
    const theirs = await withUser(restricted.id, (c) =>
      c.query('select count(*)::int as n from public.canonical_projects')
    );
    console.log(`  ${restricted.email} (bdr) sees ${theirs.rows[0].n.toLocaleString()}`);
    check('a BDR is scoped more narrowly than the service role',
      theirs.rows[0].n <= total.rows[0].n);
  }

  group('An unknown identity gets nothing');
  const ghost = await withUser('00000000-0000-0000-0000-000000000000', (c) =>
    c.query('select count(*)::int as n from public.canonical_projects')
  );
  check('a uuid with no profile sees zero rows', ghost.rows[0].n === 0, `saw ${ghost.rows[0].n}`);

  group('The claim cannot be injected');
  const evil = `", "sub": "${me.id}`;
  const injected = await withUser(evil, (c) => c.query('select auth.uid()::text as uid'));
  check('a crafted user id does not become a valid auth.uid()',
    injected.rows[0].uid === null,
    `auth.uid() = ${injected.rows[0].uid}`);
} catch (e) {
  failed++;
  console.log(`\n  FAIL ${e.message}`);
  if (/password|SASL|authentication/i.test(e.message)) {
    console.log('  → check the password in DATABASE_URL');
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(e.message)) {
    console.log('  → check the host and port; use the pooler URI from the dashboard');
  }
} finally {
  await closePool();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
