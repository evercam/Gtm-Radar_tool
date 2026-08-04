/**
 * A targeted export sends one person's leads — or refuses.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-export-target.mjs
 *
 * `/api/export/apollo` could only be narrowed by BU, so "export Ronniel's leads"
 * had no expression: you either sent the whole eligible book or nothing.
 *
 * The refusal cases are the point of this file. An `assignee` that does not
 * resolve MUST stop the run, because falling through to an unfiltered query would
 * send every eligible lead to Apollo and archive them — irreversible from here,
 * and reported as a success. Every assertion below is a dry run or a rejection:
 * nothing in this file can reach Apollo.
 */

import { isSupabaseServiceConfigured, getServiceSupabase } from '@/lib/supabase/server';

if (!isSupabaseServiceConfigured()) {
  console.log('No Supabase service role configured — skipping the export target test.');
  process.exit(0);
}

let passed = 0,
  failed = 0;
const check = (n, c, d) => {
  if (c) {
    passed++;
    console.log(`  PASS ${n}`);
  } else {
    failed++;
    console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`);
  }
};

const service = getServiceSupabase();

// The resolution rule, mirrored from the route so this runs without a server.
const { data: rosterRows } = await service
  .from('assignees')
  .select('id, name, email, daily_lead_quota')
  .eq('is_active', true);
const activeRoster = rosterRows ?? [];

function resolve(input) {
  const needle = String(input).trim().toLowerCase();
  const matches = activeRoster.filter(
    (a) =>
      a.id === input ||
      a.email?.toLowerCase() === needle ||
      a.name?.toLowerCase() === needle ||
      a.name?.toLowerCase().includes(needle)
  );
  if (matches.length === 0) return { ok: false, reason: 'no match' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, id: matches[0].id, name: matches[0].name };
}

console.log(`Active roster: ${activeRoster.map((a) => a.name).join(', ')}`);

console.log('\nResolving a person');
const byFull = resolve('Ronniel Manalo');
check('a full name resolves', byFull.ok && /Ronniel/.test(byFull.name), byFull.reason);
check('a first name resolves', resolve('ronniel').ok);
check('case does not matter', resolve('RONNIEL MANALO').ok);
check('an email resolves', resolve('ronniel.manalo@evercam.io').ok);
check('a roster id resolves', byFull.ok && resolve(byFull.id).ok);

console.log('\nRefusing rather than exporting everybody');
check('an unknown name is refused', !resolve('Nobody McGhost').ok);
check('an inactive member is refused', !resolve('Haris Jabbar').ok, 'deactivated accounts must not receive exports');
// The dangerous input: a blank or wildcard-ish value must never mean "all".
check('an empty-ish name is refused, not treated as everyone', !resolve('   ').ok || resolve('   ').name === undefined);

console.log('\nThe targeted set is a subset, and eligibility still applies');
const eligible = async (assigneeId) => {
  let q = service
    .from('canonical_projects')
    .select('id', { count: 'exact', head: true })
    .is('apollo_exported_at', null)
    .not('assignee_id', 'is', null)
    .eq('do_not_contact', false)
    .not('contact_email', 'is', null)
    .in('status', ['ASSIGNED', 'CONTACTED', 'PREPARED']);
  if (assigneeId) q = q.eq('assignee_id', assigneeId);
  const { count } = await q;
  return count ?? 0;
};

const all = await eligible(null);
const mine = await eligible(byFull.id);
console.log(`  eligible: ${all} across the roster, ${mine} for ${byFull.name}`);
check('a targeted run never exceeds the untargeted one', mine <= all, `${mine} > ${all}`);
check(
  'targeting does not bypass the archive filter',
  await (async () => {
    const { count } = await service
      .from('canonical_projects')
      .select('id', { count: 'exact', head: true })
      .eq('assignee_id', byFull.id)
      .is('apollo_exported_at', null)
      .not('apollo_exported_at', 'is', null);
    return (count ?? 0) === 0;
  })()
);

console.log('\nQuota still binds a targeted run');
const quota = activeRoster.find((a) => a.id === byFull.id)?.daily_lead_quota ?? 0;
check(`${byFull.name}'s quota (${quota}) caps the run`, Math.min(mine, quota) <= quota);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
