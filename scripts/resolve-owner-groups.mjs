#!/usr/bin/env node
/**
 * Upgrades name-based owner groups to identifier-based ones.
 *
 *   npm run resolve:owners -- [--dry]
 *
 * Ingest can only see one row at a time, so a row whose tracker publishes no
 * entity id gets `N:<slug>` even when the SAME company is identified by
 * `E:<id>` on a row in another tracker. This pass is the corpus-wide step that
 * joins those up: it learns `slug -> entity id` from every row that has both,
 * then rewrites matching `N:` rows to the `E:` form.
 *
 * Deliberately a separate pass rather than part of ingest, because the knowledge
 * arrives out of order — solar.json can be uploaded weeks before coal_plant.json
 * supplies the id for the same owner. Re-running is how the corpus improves.
 *
 * Safety properties:
 *   - A slug that maps to MORE THAN ONE entity id is left alone. Two companies
 *     sharing a slugged name is exactly when a guess would merge real accounts.
 *   - Only `N:` rows are ever rewritten. A row that already carries an id from
 *     its own source is never overwritten by an inference.
 *   - Idempotent: a second run finds nothing left to do.
 *   - `--dry` prints the plan and writes nothing.
 */

import pg from 'pg';

// Shared with ingest and verify-owner-groups — see lib/keyaccount.ts on why
// this must not be reimplemented here.
const { ownerNameSlug } = await import('../src/lib/keyaccount.ts');

const dry = process.argv.includes('--dry');
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const slugOf = ownerNameSlug;

try {
  // ---- phase 1: fill in what ingest could not ------------------------------
  // Only the GEM normalizer sets owner_group_key today, so records from the
  // other 22 adapters carry an owner name and no group. Rather than leave the
  // column meaning "GEM only", derive the name-based key here for any source.
  // An adapter that learns to publish a real owner id later will simply produce
  // `E:` at ingest and phase 2 will stop touching those rows.
  //
  // Scoped to projects: an `account` record IS an owner, so grouping it under
  // one would conflate the two kinds of row.
  const missing = (
    await c.query(`
      select id, company_name_raw from canonical_projects
      where owner_group_key is null and company_name_raw is not null and record_type = 'project'`)
  ).rows;

  const fills = new Map();
  for (const r of missing) {
    const s = slugOf(r.company_name_raw);
    if (!s) continue;
    if (!fills.has(s)) fills.set(s, []);
    fills.get(s).push(r.id);
  }
  const fillTotal = [...fills.values()].reduce((a, b) => a + b.length, 0);
  console.log(`rows with a name but no group ${missing.length.toLocaleString()}  -> fillable ${fillTotal.toLocaleString()}`);

  if (!dry && fillTotal > 0) {
    let filled = 0;
    for (const [s, ids] of fills) {
      const res = await c.query(
        `update canonical_projects set owner_group_key = $1
         where id = any($2::uuid[]) and owner_group_key is null`,
        [`N:${s}`, ids]
      );
      filled += res.rowCount;
    }
    console.log(`filled                        ${filled.toLocaleString()}`);
  }

  // ---- phase 2: upgrade name groups to identifier groups -------------------
  // Read after phase 1 so rows just filled are eligible for the bridge.
  const { rows } = await c.query(`
    select id, owner_group_key, company_name_raw
    from canonical_projects
    where owner_group_key is not null and company_name_raw is not null`);

  // Learn slug -> entity id, and record slugs that are ambiguous.
  const learned = new Map();
  const ambiguous = new Set();
  for (const r of rows) {
    if (!r.owner_group_key.startsWith('E:')) continue;
    const slug = slugOf(r.company_name_raw);
    if (!slug) continue;
    const id = r.owner_group_key.slice(2);
    const seen = learned.get(slug);
    if (seen && seen !== id) ambiguous.add(slug);
    else learned.set(slug, id);
  }
  for (const s of ambiguous) learned.delete(s);

  // Plan the rewrites.
  const plan = new Map(); // entity id -> row ids
  for (const r of rows) {
    if (!r.owner_group_key.startsWith('N:')) continue;
    const id = learned.get(r.owner_group_key.slice(2));
    if (!id) continue;
    if (!plan.has(id)) plan.set(id, []);
    plan.get(id).push(r.id);
  }

  const total = [...plan.values()].reduce((a, b) => a + b.length, 0);
  console.log(`rows with an owner group     ${rows.length.toLocaleString()}`);
  console.log(`slug -> id mappings learned  ${learned.size.toLocaleString()}`);
  console.log(`ambiguous slugs skipped      ${ambiguous.size}`);
  console.log(`rows to upgrade N: -> E:     ${total.toLocaleString()}`);

  if (dry) {
    for (const [id, ids] of [...plan.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
      console.log(`   E:${id}  <- ${ids.length} rows`);
    }
    console.log('\nDRY RUN — nothing written.');
  } else if (total > 0) {
    let done = 0;
    for (const [id, ids] of plan) {
      // Guarded on the N: prefix so a concurrent writer that set a real id
      // cannot be clobbered between the read above and this update.
      const res = await c.query(
        `update canonical_projects set owner_group_key = $1
         where id = any($2::uuid[]) and owner_group_key like 'N:%'`,
        [`E:${id}`, ids]
      );
      done += res.rowCount;
    }
    console.log(`upgraded                     ${done.toLocaleString()}`);
  }

  const after = await c.query(`
    select count(*) filter (where owner_group_key like 'E:%') as identifier_backed,
           count(*) filter (where owner_group_key like 'N:%') as name_backed,
           count(*) filter (where owner_group_key is null)    as ungrouped,
           count(distinct owner_group_key)                    as groups
    from canonical_projects where record_type='project'`);
  console.log('\nafter:', JSON.stringify(after.rows[0]));
} finally {
  await c.end();
}
