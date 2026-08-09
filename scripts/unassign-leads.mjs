#!/usr/bin/env node
/**
 * Hands assigned leads back to the pool.
 *
 *   # show what would change, write nothing
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/unassign-leads.mjs
 *
 *   # do it
 *   APPLY=1 node --env-file=.env.local --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/unassign-leads.mjs
 *
 *   --exported=skip|include   what to do with leads already sent to Apollo
 *                             (default: skip — see below)
 *   --assignee="Name"         only this person's leads
 *   --clear-export            also clear the Apollo export marks, so a lead can
 *                             be exported again cleanly
 *   --restore=<file>          put a previous run's assignments back
 *
 * Dry by default, and it writes a RESTORE FILE before touching anything. An
 * assignment is somebody's work queue; being able to say "put it back exactly as
 * it was" is worth the few kilobytes, and the alternative is reconstructing it
 * from memory.
 *
 * Status goes back to PREPARED, not to null. ASSIGNED -> PREPARED is a legal
 * transition and PREPARED is what the record genuinely is again: enriched,
 * briefed, waiting for an owner. Leaving status at ASSIGNED with no assignee is
 * the invalid state this tool has produced by accident before — the lead looks
 * owned, appears in no queue, and is invisible to both the dashboard and the
 * allocator.
 *
 * EXPORTED LEADS ARE SKIPPED BY DEFAULT, and that is the important decision
 * here. Unassigning in this tool does not touch Apollo: the contact stays there,
 * still owned by the same rep, still in their views. Clearing it on this side
 * only makes the two disagree — the tool says unowned, Apollo says Anas — and
 * nothing here can reconcile that. Pass --exported=include when you have decided
 * that is what you want, and repair the Apollo side separately with
 * scripts/repair-apollo-ownership.mjs.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getRoster } from '@/lib/assignmentStore';

const args = process.argv.slice(2);
const apply = process.env.APPLY === '1';
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;

const exportedMode = flag('exported') ?? 'skip';
const onlyAssignee = flag('assignee');
const restoreFile = flag('restore');
/*
  Clearing the export marks makes a lead exportable again. It does NOT delete
  anything in Apollo — the contact is still there — so a later export can create
  a second copy of the same person. Opt-in for that reason.
*/
const clearExport = args.includes('--clear-export');

if (!['skip', 'include'].includes(exportedMode)) {
  console.error('--exported must be skip or include.');
  process.exit(1);
}
if (!isSupabaseServiceConfigured()) {
  console.error('Supabase service role is not configured — run with --env-file=.env.local');
  process.exit(1);
}

const s = getServiceSupabase();

/* -------------------------------------------------------------------------- */
/* Restore                                                                     */
/* -------------------------------------------------------------------------- */

if (restoreFile) {
  const saved = JSON.parse(readFileSync(restoreFile, 'utf8'));
  console.log(`Restoring ${saved.length} assignment(s) from ${restoreFile}`);
  if (!apply) {
    console.log('DRY RUN — re-run with APPLY=1 to write.');
    process.exit(0);
  }
  let done = 0;
  for (const r of saved) {
    const { error } = await s
      .from('canonical_projects')
      .update({
        assignee_id: r.assignee_id,
        owner_user_id: r.owner_user_id,
        owner_assigned_at: r.owner_assigned_at,
        status: r.status,
        // Present only when the run used --clear-export; undefined keys are
        // dropped by the client, so an ordinary restore leaves them alone.
        ...(r.apollo_exported_at !== undefined
          ? {
              apollo_exported_at: r.apollo_exported_at,
              apollo_contact_id: r.apollo_contact_id,
              apollo_export_status: r.apollo_export_status,
              apollo_export_error: r.apollo_export_error,
            }
          : {}),
      })
      .eq('id', r.id);
    if (error) console.log(`  FAILED ${r.id}: ${error.message}`);
    else done += 1;
  }
  console.log(`${done} of ${saved.length} restored.`);
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* Unassign                                                                    */
/* -------------------------------------------------------------------------- */

let assigneeId = null;
if (onlyAssignee) {
  const { rows } = await getRoster();
  const hits = rows.filter((r) => r.name?.toLowerCase().includes(onlyAssignee.toLowerCase()));
  if (hits.length !== 1) {
    console.error(
      hits.length === 0
        ? `No roster member matches "${onlyAssignee}".`
        : `"${onlyAssignee}" matches ${hits.length}: ${hits.map((h) => h.name).join(', ')}`
    );
    process.exit(1);
  }
  assigneeId = hits[0].id;
  console.log(`Scoped to ${hits[0].name}.`);
}

// Paged: PostgREST caps a response at 1000 rows, and a silent truncation here
// would leave part of the book assigned while reporting the job done.
const rows = [];
for (let page = 0; page < 100; page += 1) {
  let q = s
    .from('canonical_projects')
    .select('id, ref_code, canonical_name, status, assignee_id, owner_user_id, owner_assigned_at, apollo_exported_at, apollo_contact_id, apollo_export_status, apollo_export_error')
    .not('assignee_id', 'is', null)
    .order('id', { ascending: true })
    .range(page * 1000, (page + 1) * 1000 - 1);
  if (assigneeId) q = q.eq('assignee_id', assigneeId);
  const { data, error } = await q;
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < 1000) break;
}

const { rows: roster } = await getRoster();
const nameOf = (id) => roster.find((r) => r.id === id)?.name ?? '(not on the roster)';

const exported = rows.filter((r) => r.apollo_exported_at);
const fresh = rows.filter((r) => !r.apollo_exported_at);
const target = exportedMode === 'include' ? rows : fresh;

console.log(`\n${rows.length} assigned lead(s)`);
const byPerson = {};
for (const r of rows) {
  const k = nameOf(r.assignee_id);
  byPerson[k] ??= { total: 0, exported: 0 };
  byPerson[k].total += 1;
  if (r.apollo_exported_at) byPerson[k].exported += 1;
}
for (const [name, c] of Object.entries(byPerson).sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${String(c.total).padStart(4)}  ${name.padEnd(20)} (${c.exported} already in Apollo)`);
}

console.log(`\nwould unassign : ${target.length}`);
if (clearExport) {
  const marked = target.filter((r) => r.apollo_exported_at).length;
  console.log(
    `would CLEAR    : the Apollo export marks on ${marked} of them, so they can be exported again.\n` +
      `                 Those contacts are NOT deleted from Apollo — re-exporting may duplicate them there.`
  );
}
if (exportedMode === 'skip' && exported.length) {
  console.log(
    `would KEEP     : ${exported.length} already sent to Apollo — unassigning here would not unassign them there,\n` +
      `                 leaving the two systems disagreeing. Pass --exported=include to override.`
  );
}

if (target.length === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}

if (!apply) {
  console.log('\nDRY RUN — nothing written. Re-run with APPLY=1.');
  process.exit(0);
}

// Written BEFORE the update, so an interrupted run still leaves a way back.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `unassigned-${stamp}.json`;
writeFileSync(
  backup,
  JSON.stringify(
    target.map((r) => ({
      id: r.id,
      ref_code: r.ref_code,
      assignee_id: r.assignee_id,
      owner_user_id: r.owner_user_id,
      owner_assigned_at: r.owner_assigned_at,
      status: r.status,
      // Only recorded when they are about to be cleared, so a restore knows
      // whether it is responsible for putting them back.
      ...(clearExport
        ? {
            apollo_exported_at: r.apollo_exported_at,
            apollo_contact_id: r.apollo_contact_id,
            apollo_export_status: r.apollo_export_status,
            apollo_export_error: r.apollo_export_error,
          }
        : {}),
    })),
    null,
    2
  )
);
console.log(`\nRestore file written: ${backup}`);

/*
  Chunked. A single `.in()` with several hundred ids overruns what PostgREST
  accepts in a URL, and the failure is a request error rather than a partial
  write — but the chunking also keeps each statement inside the timeout.
*/
const CHUNK = 200;
let updated = 0;
for (let i = 0; i < target.length; i += CHUNK) {
  const ids = target.slice(i, i + CHUNK).map((r) => r.id);
  const { error } = await s
    .from('canonical_projects')
    .update({
      assignee_id: null,
      owner_user_id: null,
      owner_assigned_at: null,
      // Back to what the record actually is: enriched, briefed, waiting for an
      // owner. Leaving it ASSIGNED with no assignee is the invalid state that
      // makes a lead invisible to both the dashboard and the allocator.
      status: 'PREPARED',
      ...(clearExport
        ? {
            apollo_exported_at: null,
            apollo_contact_id: null,
            apollo_export_status: null,
            apollo_export_error: null,
          }
        : {}),
    })
    .in('id', ids);
  if (error) {
    console.log(`  FAILED chunk ${i / CHUNK + 1}: ${error.message}`);
    continue;
  }
  updated += ids.length;
}

console.log(`${updated} of ${target.length} unassigned and returned to PREPARED.`);
if (exportedMode === 'include' && exported.length) {
  console.log(
    `\n${exported.length} of them are still contacts in Apollo, owned by the rep they were sent to.\n` +
      `Nothing here changed that — use scripts/repair-apollo-ownership.mjs if the Apollo side should move too.`
  );
}
console.log(`Put it back with:  APPLY=1 node ... scripts/unassign-leads.mjs --restore=${backup}`);
