/**
 * Creates the Apollo custom fields the export needs but the workspace lacks.
 *
 *   # show what is missing, change nothing
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/provision-apollo-fields.mjs
 *
 *   # actually create them
 *   APPLY=1 node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/provision-apollo-fields.mjs
 *
 * Dry by default, because this writes SCHEMA to a live CRM that other people also
 * edit. A stray custom field is not destructive, but it is visible to everyone in
 * the workspace and nobody asked for it.
 *
 * Only ever creates what is genuinely absent, and only contact-modality textarea
 * fields. It never edits or deletes an existing field: a name collision means
 * somebody already has a field by that name, and silently rewriting it is how you
 * lose another team's data.
 */

import { readSecret } from '@/lib/crypto/store';
import { loadCustomFields, FIELD_MAP } from '@/lib/export/apolloFields';

const BASE = 'https://api.apollo.io';
const apply = process.env.APPLY === '1';

const key = await readSecret('apollo_api_key');
if (!key) {
  console.error('No Apollo key configured. Add one in Settings.');
  process.exit(1);
}
const h = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': key };

const WRITABLE = new Set(['string', 'textarea', 'text']);
const existing = await loadCustomFields(true);
if (existing.length === 0) {
  console.error('Apollo returned no custom fields — check the key.');
  process.exit(1);
}

console.log(`${existing.length} custom fields in the workspace.\n`);

const report = [];
for (const { source, apolloName } of FIELD_MAP) {
  const byName = existing.filter((f) => f.name === apolloName);
  const usable = byName.find((f) => f.modality === 'contact' && WRITABLE.has(f.type));
  if (usable) {
    report.push({ source, apolloName, state: 'ok', detail: `${usable.type}${usable.maxLength != null ? `, max ${usable.maxLength}` : ''}` });
  } else if (byName.length) {
    // Exists, but not somewhere a contact write can land. NOT ours to change.
    report.push({
      source,
      apolloName,
      state: 'wrong-place',
      detail: byName.map((f) => `${f.modality}/${f.type}`).join(', '),
    });
  } else {
    report.push({ source, apolloName, state: 'missing', detail: 'would be created as contact/textarea' });
  }
}

for (const r of report) {
  const mark = r.state === 'ok' ? 'ok        ' : r.state === 'missing' ? 'MISSING   ' : 'WRONG PLACE';
  console.log(`  ${mark} ${r.source.padEnd(18)} -> "${r.apolloName}"  (${r.detail})`);
}

const missing = report.filter((r) => r.state === 'missing');
const wrong = report.filter((r) => r.state === 'wrong-place');

if (wrong.length) {
  console.log(`\n${wrong.length} target(s) exist but cannot receive a contact write:`);
  for (const r of wrong) console.log(`  "${r.apolloName}" is ${r.detail}`);
  console.log('These are NOT created or altered — another workflow may own them.');
  console.log('Re-point them in Settings → Apollo export fields, or switch them off.');
}

if (missing.length === 0) {
  console.log('\nNothing to create.');
  process.exit(0);
}

if (!apply) {
  console.log(`\n${missing.length} field(s) would be created. Re-run with APPLY=1 to do it.`);
  process.exit(0);
}

console.log(`\nCreating ${missing.length} field(s):`);
let made = 0;
for (const r of missing) {
  const res = await fetch(`${BASE}/api/v1/typed_custom_fields`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ name: r.apolloName, type: 'textarea', modality: 'contact' }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  if (!res.ok) {
    console.log(`  FAILED "${r.apolloName}" -> HTTP ${res.status} ${body.slice(0, 160)}`);
    continue;
  }
  let id = null;
  try {
    id = (JSON.parse(body).typed_custom_field ?? JSON.parse(body)).id ?? null;
  } catch {
    // The field is created either way; only the id is unavailable to print.
  }
  made += 1;
  console.log(`  created "${r.apolloName}"  id=${id ?? 'unknown'}`);
}

console.log(`\n${made} of ${missing.length} created.`);
if (made) {
  console.log('The default mapping already points at these names, so the next export uses them.');
  console.log('Check Settings → Apollo export fields to confirm they now resolve.');
}
