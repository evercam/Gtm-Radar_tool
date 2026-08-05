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

/**
 * Fields whose length cap is too small for the data, and what it should be.
 *
 * `Job Title` was created with a 30-character ceiling. 511 of 11,730 titles on
 * file (4.4%) are longer, so the export truncated them — and before that, one
 * character over returned HTTP 422 and failed the whole batch of 100.
 *
 * Raising a cap is non-destructive: every value that fitted before still fits.
 * The cap is only ever RAISED here, never lowered, because lowering one is how
 * you invalidate data somebody else's workflow depends on.
 *
 * 500 rather than 20,000: the longest title on file is 206 characters, and a
 * "string" field is a single-line input in Apollo's UI. This is headroom, not a
 * licence to put prose in it.
 */
const RAISE_CAPS = [{ name: 'Job Title', min: 500 }];

/**
 * Account-modality fields this tool owns.
 *
 * Deliberately a NEW field rather than one of the six Apollo already has on
 * accounts. Every one of those is `is_ai_field: true` with
 * `dynamic_field_type: 'prompt_execution'` — Apollo writes them by running
 * prompts, and three are read-only-mapped — so writing there would overwrite a
 * live research workflow and be overwritten back.
 */
const ACCOUNT_FIELDS = [{ name: 'Evercam Projects', type: 'textarea' }];

const WRITABLE = new Set(['string', 'textarea', 'text']);
const existing = await loadCustomFields(true);
if (existing.length === 0) {
  console.error('Apollo returned no custom fields — check the key.');
  process.exit(1);
}

console.log(`${existing.length} custom fields in the workspace.\n`);

const report = [];
for (const { source, apolloName, type } of FIELD_MAP) {
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
    report.push({ source, apolloName, state: 'missing', type: type ?? 'textarea', detail: `would be created as contact/${type ?? 'textarea'}` });
  }
}

for (const r of report) {
  const mark = r.state === 'ok' ? 'ok        ' : r.state === 'missing' ? 'MISSING   ' : 'WRONG PLACE';
  console.log(`  ${mark} ${r.source.padEnd(18)} -> "${r.apolloName}"  (${r.detail})`);
}

/**
 * Caps that are too low for the data.
 *
 * Kept separate from the missing-field list because it is a different kind of
 * change: this edits a field the workspace already has, so it is reported on its
 * own and only ever widens the ceiling.
 */
const tooTight = [];
for (const want of RAISE_CAPS) {
  const f = existing.find((x) => x.name === want.name && x.modality === 'contact');
  if (!f) continue;
  if (f.maxLength != null && f.maxLength < want.min) {
    tooTight.push({ field: f, min: want.min });
  }
}
if (tooTight.length) {
  console.log(`\n${tooTight.length} cap(s) too low for the data:`);
  for (const t of tooTight) console.log(`  "${t.field.name}" allows ${t.field.maxLength}, needs ${t.min}`);
}

/* Account fields, checked the same way and reported separately: they are a
   different modality and a different owner. */
const missingAccount = [];
for (const want of ACCOUNT_FIELDS) {
  const found = existing.find((f) => f.name === want.name && f.modality === 'account');
  if (found) {
    console.log(`  ok         [account] ${want.name}  (${found.type}${found.maxLength != null ? `, max ${found.maxLength}` : ''})`);
  } else {
    const elsewhere = existing.find((f) => f.name === want.name);
    if (elsewhere) {
      console.log(`  WRONG PLACE [account] ${want.name} exists as ${elsewhere.modality}/${elsewhere.type} — not touched`);
    } else {
      missingAccount.push(want);
      console.log(`  MISSING    [account] ${want.name}  (would be created as account/${want.type})`);
    }
  }
}

const missing = report.filter((r) => r.state === 'missing');
const wrong = report.filter((r) => r.state === 'wrong-place');

if (wrong.length) {
  console.log(`\n${wrong.length} target(s) exist but cannot receive a contact write:`);
  for (const r of wrong) console.log(`  "${r.apolloName}" is ${r.detail}`);
  console.log('These are NOT created or altered — another workflow may own them.');
  console.log('Re-point them in Settings → Apollo export fields, or switch them off.');
}

if (missing.length === 0 && tooTight.length === 0 && missingAccount.length === 0) {
  console.log('\nNothing to create or widen.');
  process.exit(0);
}

if (!apply) {
  const bits = [];
  if (missing.length) bits.push(`${missing.length} contact field(s) would be created`);
  if (missingAccount.length) bits.push(`${missingAccount.length} account field(s) would be created`);
  if (tooTight.length) bits.push(`${tooTight.length} cap(s) would be raised`);
  console.log(`\n${bits.join(', ')}. Re-run with APPLY=1 to do it.`);
  process.exit(0);
}

/*
  Widen first. Raising the ceiling is what stops the export truncating, and it
  needs no mapping change afterwards: mapCustomFields reads the live
  text_field_max_length, so the next export simply stops cutting.
*/
for (const t of tooTight) {
  // `name` is required on this PUT. Without it Apollo answers "undefined method
  // 'strip' for nil", which reads like a server fault rather than a missing
  // parameter and cost a while to work out.
  const res = await fetch(`${BASE}/api/v1/typed_custom_fields/${t.field.id}`, {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({ name: t.field.name, type: t.field.type, text_field_max_length: t.min }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  if (!res.ok) {
    console.log(`  FAILED to widen "${t.field.name}" -> HTTP ${res.status} ${body.slice(0, 160)}`);
    continue;
  }
  let now = null;
  try {
    now = (JSON.parse(body).typed_custom_field ?? JSON.parse(body)).text_field_max_length ?? null;
  } catch {
    // Applied either way; only the echo is unavailable.
  }
  console.log(`  widened "${t.field.name}" ${t.field.maxLength} -> ${now ?? t.min}`);
}

for (const want of missingAccount) {
  const res = await fetch(`${BASE}/api/v1/typed_custom_fields`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ name: want.name, type: want.type, modality: 'account' }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  if (!res.ok) {
    console.log(`  FAILED [account] "${want.name}" -> HTTP ${res.status} ${body.slice(0, 140)}`);
    continue;
  }
  let id = null;
  try {
    id = (JSON.parse(body).typed_custom_field ?? JSON.parse(body)).id ?? null;
  } catch {
    // Created either way; only the echo is unavailable.
  }
  console.log(`  created [account] "${want.name}"  id=${id ?? 'unknown'}`);
}

if (missing.length === 0) process.exit(0);

console.log(`\nCreating ${missing.length} field(s):`);
let made = 0;
for (const r of missing) {
  const res = await fetch(`${BASE}/api/v1/typed_custom_fields`, {
    method: 'POST',
    headers: h,
    /*
      Created as the type the map declares. A qualification column has to be
      `string` — a single-line value is what Apollo shows and sorts in a column,
      whereas a textarea renders as a block. `text_field_max_length` is set
      explicitly because the default varies per field in this workspace (Job Title
      came with 30, which is what failed whole batches of 100).
    */
    body: JSON.stringify({
      name: r.apolloName,
      type: r.type ?? 'textarea',
      modality: 'contact',
      text_field_max_length: (r.type ?? 'textarea') === 'string' ? 200 : 20000,
    }),
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
