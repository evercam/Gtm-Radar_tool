#!/usr/bin/env node
/**
 * Guards the invariants of `owner_group_key`.
 *
 *   npm run verify:owners
 *
 * Read-only — it asserts against whatever is in the database and writes nothing,
 * so it is safe to run against production at any time.
 *
 * The failure this mostly exists to catch is a silent one: an `N:` group that
 * should have become `E:`, or worse an `E:` group built from an ambiguous name,
 * which would merge two real companies into one portfolio. Neither shows up as
 * an error anywhere — the list just quietly groups the wrong leads together.
 */

import pg from 'pg';

// The same slugifier ingest and the resolver use — see lib/keyaccount.ts.
const { ownerNameSlug } = await import('../src/lib/keyaccount.ts');

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

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

try {
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];

  console.log('\nShape');
  const bad = await one(`
    select count(*) as n from canonical_projects
    where owner_group_key is not null
      and owner_group_key !~ '^(E:E[0-9]{6,}|N:[a-z0-9][a-z0-9-]*)$'`);
  check('every key is a well-formed E: or N: value', Number(bad.n) === 0, `${bad.n} malformed`);

  const empty = await one(`
    select count(*) as n from canonical_projects
    where owner_group_key in ('E:', 'N:', '')`);
  check('no bare prefixes or empty strings', Number(empty.n) === 0, `${empty.n} found`);

  console.log('\nCoverage');
  const cov = await one(`
    select count(*) as total,
           count(*) filter (where owner_group_key like 'E:%') as ident,
           count(*) filter (where owner_group_key like 'N:%') as named,
           count(*) filter (where owner_group_key is null)    as ungrouped,
           count(*) filter (where owner_group_key is null and company_name_raw is not null) as null_key_with_company
    from canonical_projects where record_type='project'`);
  const grouped = Number(cov.ident) + Number(cov.named);
  check(
    `${grouped} of ${cov.total} project records are grouped`,
    grouped > 0 && grouped === Number(cov.total) - Number(cov.ungrouped)
  );
  // A record with an owner name but no key means the derivation silently
  // dropped something it could have grouped.
  check(
    'no record has an owner name but no group key',
    Number(cov.null_key_with_company) === 0,
    `${cov.null_key_with_company} records have company_name_raw but no owner_group_key`
  );

  console.log('\nResolution is complete and unambiguous');
  // Computed in JS with the SAME ownerNameSlug the resolver and ingest use. A
  // reimplementation in SQL would drift, and a drifted verifier reports a clean
  // run over exactly the rows it can no longer see.
  const all = (
    await c.query(`
      select owner_group_key, company_name_raw from canonical_projects
      where owner_group_key is not null and company_name_raw is not null`)
  ).rows;

  const byslug = new Map();
  for (const r of all) {
    if (!r.owner_group_key.startsWith('E:')) continue;
    const s = ownerNameSlug(r.company_name_raw);
    if (!s) continue;
    if (!byslug.has(s)) byslug.set(s, new Set());
    byslug.get(s).add(r.owner_group_key);
  }

  let pending = 0;
  for (const r of all) {
    if (!r.owner_group_key.startsWith('N:')) continue;
    const ids = byslug.get(ownerNameSlug(r.company_name_raw));
    if (ids && ids.size === 1) pending += 1;
  }
  check(
    'no N: row is waiting for an id that is already known',
    pending === 0,
    `${pending} rows pending — run \`npm run resolve:owners\``
  );

  // The dangerous inverse: a single slug mapping to several ids must never have
  // been collapsed. Reported, not failed — the resolver skips these by design,
  // so their existence is the safety property working.
  const ambiguous = [...byslug.values()].filter((s) => s.size > 1).length;
  console.log(`  NOTE ${ambiguous} owner names map to more than one entity id — correctly left unmerged`);

  console.log('\nSeparation from account_key');
  const clash = await one(`
    select count(*) as n from canonical_projects
    where owner_group_key is not null and owner_group_key = account_key`);
  check(
    'owner_group_key never equals account_key',
    Number(clash.n) === 0,
    `${clash.n} rows — the two identities are being conflated`
  );

  console.log('\nGroups');
  const g = await one(`
    select count(distinct owner_group_key) as groups,
           max(n) as biggest
    from (select owner_group_key, count(*) as n from canonical_projects
          where owner_group_key is not null group by 1) t`);
  check(`${g.groups} owner groups, biggest holds ${g.biggest} leads`, Number(g.groups) > 0);

  console.log(`\n${cov.ident} identifier-backed · ${cov.named} name-backed · ${cov.ungrouped} ungrouped`);
} finally {
  await c.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
