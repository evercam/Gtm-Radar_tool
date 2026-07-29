/**
 * What Apollo actually exposes, read from the live API.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/probe-apollo-schema.mjs
 *
 * The export currently guesses at Apollo's contact shape. Rather than keep
 * guessing, this asks: which fields exist on a contact, which custom fields
 * this workspace has defined, who the users are (for contact/account owner),
 * what lists exist, and what sequences are available to enrol into.
 *
 * Read-only, and deliberately metadata-first: the endpoints that describe the
 * workspace cost nothing, unlike people search which bills per record. The one
 * search here is over YOUR OWN contacts, which is your data, not Apollo's
 * database.
 */

import { readSecret } from '@/lib/crypto/store';

const BASE = 'https://api.apollo.io';

const apiKey = await readSecret('apollo_api_key');
if (!apiKey) {
  console.error('No Apollo key configured. Add one in Settings.');
  process.exit(1);
}

const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey };

async function call(method, path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e) };
  }
}

function heading(t) {
  console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
}

/** Field names and their runtime types, so the shape is obvious at a glance. */
function describe(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const t = v === null ? 'null' : Array.isArray(v) ? `array[${v.length}]` : typeof v;
    out.push(`${prefix}${k}  ${t}`);
    if (v && typeof v === 'object' && !Array.isArray(v) && prefix.length < 4) {
      out.push(...describe(v, `${prefix}  `).slice(0, 12));
    }
  }
  return out;
}

heading('1 · Users — who a contact or account can be OWNED by');
{
  const r = await call('POST', '/api/v1/users/search', { page: 1, per_page: 25 });
  if (!r.ok) {
    console.log(`  HTTP ${r.status}: ${r.text.slice(0, 200).replace(/\s+/g, ' ')}`);
  } else {
    const users = r.json?.users ?? r.json?.people ?? [];
    console.log(`  ${users.length} user(s)`);
    for (const u of users.slice(0, 15)) {
      console.log(`    ${(u.id ?? '').padEnd(26)} ${(u.name ?? `${u.first_name ?? ''} ${u.last_name ?? ''}`).trim().padEnd(26)} ${u.email ?? ''}`);
    }
    if (users[0]) console.log('\n  fields:', Object.keys(users[0]).join(', '));
  }
}

heading('2 · Custom fields defined in this workspace');
for (const path of ['/api/v1/typed_custom_fields', '/v1/typed_custom_fields']) {
  const r = await call('GET', path);
  console.log(`  ${path} → HTTP ${r.status}`);
  if (r.ok) {
    const fields = r.json?.typed_custom_fields ?? r.json?.custom_fields ?? [];
    for (const f of fields) console.log(`    ${(f.name ?? f.label ?? '?').padEnd(30)} ${f.type ?? f.field_type ?? ''}  id=${f.id ?? ''}`);
    if (fields.length === 0) console.log('    (none defined)');
    break;
  }
}

heading('3 · Lists / labels — where a contact gets filed');
for (const path of ['/api/v1/labels', '/v1/labels']) {
  const r = await call('GET', path);
  console.log(`  ${path} → HTTP ${r.status}`);
  if (r.ok) {
    const labels = r.json?.labels ?? r.json ?? [];
    const arr = Array.isArray(labels) ? labels : [];
    console.log(`    ${arr.length} list(s)`);
    for (const l of arr.slice(0, 20)) console.log(`      ${(l.name ?? '?').padEnd(34)} id=${l.id ?? ''}  contacts=${l.cached_count ?? l.count ?? '?'}`);
    break;
  }
}

heading('4 · Sequences — what a contact can be enrolled into');
for (const path of ['/api/v1/emailer_campaigns/search']) {
  const r = await call('POST', path, { page: 1, per_page: 25 });
  console.log(`  ${path.split('?')[0]} → HTTP ${r.status}`);
  if (r.ok) {
    const seqs = r.json?.emailer_campaigns ?? [];
    console.log(`    ${seqs.length} sequence(s)`);
    for (const s of seqs.slice(0, 15)) console.log(`      ${(s.name ?? '?').padEnd(38)} id=${s.id ?? ''}  active=${s.active ?? '?'}`);
    if (seqs[0]) console.log('\n    fields:', Object.keys(seqs[0]).join(', '));
    break;
  }
}

heading('5 · Contact shape — every field on one of YOUR contacts');
{
  const r = await call('POST', '/api/v1/contacts/search', { page: 1, per_page: 1 });
  if (!r.ok) {
    console.log(`  HTTP ${r.status}: ${r.text.slice(0, 250).replace(/\s+/g, ' ')}`);
  } else {
    const c = (r.json?.contacts ?? [])[0];
    console.log(`  total contacts in workspace: ${r.json?.pagination?.total_entries ?? '?'}`);
    if (!c) {
      console.log('  No contacts yet — nothing to describe. Push one and re-run.');
    } else {
      for (const line of describe(c)) console.log('    ' + line);
    }
  }
}

heading('6 · Account shape — every field on one of YOUR accounts');
{
  const r = await call('POST', '/api/v1/accounts/search', { page: 1, per_page: 1 });
  if (!r.ok) {
    console.log(`  HTTP ${r.status}: ${r.text.slice(0, 250).replace(/\s+/g, ' ')}`);
  } else {
    const a = (r.json?.accounts ?? [])[0];
    console.log(`  total accounts in workspace: ${r.json?.pagination?.total_entries ?? '?'}`);
    if (!a) console.log('  No accounts yet.');
    else for (const line of describe(a)) console.log('    ' + line);
  }
}

console.log('\nDone. Nothing was written and no people-search credits were spent.\n');
