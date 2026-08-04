/**
 * Puts already-exported contacts under the right owner and list in Apollo.
 *
 *   # report only
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/repair-apollo-ownership.mjs
 *
 *   # do it (optionally for one person)
 *   APPLY=1 ASSIGNEE="Anas Filali" node --env-file=.env.local ... scripts/repair-apollo-ownership.mjs
 *
 * Everything exported before the owner/list fix landed carries the API key user as
 * its owner and no list, because `bulk_create` silently ignores `owner_id` and
 * `label_names`. The contacts are in Apollo and perfectly intact — they are simply
 * invisible to the BDR they belong to, who filters by owner or opens their own
 * list and sees nothing. That looks exactly like the export never ran.
 *
 * Re-exporting does NOT fix it: dedupe returns the contact as `existing` and
 * updates none of these fields, so the run reports success and changes nothing.
 * The repair is a PUT per contact, the same call the export now makes after
 * creating one.
 *
 * Reads `apollo_contact_id` from our own records, so it only ever touches contacts
 * this tool created. It never creates, never deletes, and spends no Apollo credits.
 */

import { readSecret } from '@/lib/crypto/store';
import { getServiceSupabase } from '@/lib/supabase/server';
import { getRoster } from '@/lib/assignmentStore';
import { findApolloUserId } from '@/lib/export/apolloUsers';
import { ensureLabelId } from '@/lib/export/apollo';

const apply = process.env.APPLY === '1';
const only = process.env.ASSIGNEE?.trim();

const key = await readSecret('apollo_api_key');
if (!key) {
  console.error('No Apollo key configured.');
  process.exit(1);
}
const h = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': key };
const s = getServiceSupabase();

const { rows: roster } = await getRoster();
const targets = roster.filter((r) => (only ? r.name.toLowerCase().includes(only.toLowerCase()) : true));
if (only && targets.length !== 1) {
  console.error(
    `"${only}" matched ${targets.length} roster entries${targets.length ? `: ${targets.map((t) => t.name).join(', ')}` : ''}. Be more specific.`
  );
  process.exit(1);
}

let fixed = 0;
let already = 0;
let failed = 0;

for (const person of targets) {
  const { data: leads } = await s
    .from('canonical_projects')
    .select('canonical_name, apollo_contact_id')
    .eq('assignee_id', person.id)
    .not('apollo_contact_id', 'is', null);
  if (!leads?.length) continue;

  const ownerId = await findApolloUserId(person.email, person.name);
  const listName = `LDR — ${person.name}`;

  /*
    The per-BDR list, created only when actually applying.

    `ensureLabelId` creates a missing list as a side effect, so calling it
    unconditionally meant the REPORT-ONLY run created a list in the live
    workspace — a dry run that changes something is not a dry run. Reporting
    reads the existing lists and says the list would be created.
  */
  let labelId = null;
  if (ownerId) {
    if (apply) {
      labelId = await ensureLabelId(listName, key);
    } else {
      const raw = await (await fetch('https://api.apollo.io/api/v1/labels', { headers: h })).json();
      const labels = Array.isArray(raw) ? raw : (raw.labels ?? []);
      labelId = labels.find((l) => (l.name ?? '').trim() === listName)?.id ?? null;
    }
  }

  console.log(`\n${person.name} — ${leads.length} exported contact(s)`);
  console.log(`  apollo user: ${ownerId ?? 'NOT FOUND — cannot set an owner'}`);
  console.log(`  list "${listName}": ${labelId ?? (apply ? 'unavailable' : 'does not exist yet — would be created')}`);
  if (!ownerId) {
    console.log('  skipped: without an Apollo user there is nothing to assign them to.');
    continue;
  }

  for (const l of leads) {
    const res = await fetch(`https://api.apollo.io/v1/contacts/${l.apollo_contact_id}`, { headers: h });
    if (!res.ok) {
      failed += 1;
      console.log(`  MISSING ${l.canonical_name.slice(0, 46)} (HTTP ${res.status}) — deleted in Apollo, needs a real re-export`);
      continue;
    }
    const c = (await res.json()).contact ?? {};
    const ownerOk = c.owner_id === ownerId;
    const listOk = !labelId || (c.label_ids ?? []).includes(labelId);
    if (ownerOk && listOk) {
      already += 1;
      continue;
    }
    if (!apply) {
      console.log(`  would fix ${l.canonical_name.slice(0, 44)}  owner=${ownerOk ? 'ok' : 'wrong'} list=${listOk ? 'ok' : 'missing'}`);
      continue;
    }
    const patch = { owner_id: ownerId };
    // Preserve any list it is already on rather than replacing the array.
    if (labelId) patch.label_ids = [...new Set([...(c.label_ids ?? []), labelId])];
    const put = await fetch(`https://api.apollo.io/v1/contacts/${l.apollo_contact_id}`, {
      method: 'PUT',
      headers: h,
      body: JSON.stringify(patch),
    });
    if (put.ok) {
      fixed += 1;
    } else {
      failed += 1;
      console.log(`  FAILED  ${l.canonical_name.slice(0, 44)} -> HTTP ${put.status}`);
    }
  }
}

console.log(
  `\n${apply ? 'fixed' : 'would fix'}: ${apply ? fixed : 'see above'}   already correct: ${already}   unreachable in Apollo: ${failed}`
);
if (!apply) console.log('Re-run with APPLY=1 to write the changes.');
