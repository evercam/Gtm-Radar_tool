/**
 * Writes each company's project list onto its Apollo account.
 *
 *   # report only
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/sync-account-projects.mjs
 *
 *   # do it
 *   APPLY=1 node --env-file=.env.local ... scripts/sync-account-projects.mjs
 *
 * A BDR works outward — what is being built, then who is building it, then who to
 * call. The contact brief covers the last two but is per-person and per-project,
 * so somebody looking at Cleveland-Cliffs sees one mine and cannot tell there are
 * four more.
 *
 * Only accounts this tool has already resolved are touched: it groups by
 * `apollo_account_id` and never guesses from a domain. Five accounts in this
 * workspace share balfourbeatty.com, so a domain match would attach one company's
 * projects to another company's account — which is worse than leaving it blank.
 *
 * It UPDATES existing accounts and never creates one. It writes a single field
 * this tool owns, `Evercam Projects`, and never Apollo's six AI account fields
 * (`Qualify Account` and the rest are `is_ai_field: true` with
 * `dynamic_field_type: 'prompt_execution'`; writing there would fight a live
 * research workflow).
 */

import { readSecret } from '@/lib/crypto/store';
import { getServiceSupabase } from '@/lib/supabase/server';
import { loadCustomFields } from '@/lib/export/apolloFields';
import { renderAccountProjects, ACCOUNT_ROLLUP_MAX } from '@/lib/export/accountRollup';

const apply = process.env.APPLY === '1';
const FIELD_NAME = 'Evercam Projects';

const key = await readSecret('apollo_api_key');
if (!key) {
  console.error('No Apollo key configured.');
  process.exit(1);
}
const h = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': key };

const field = (await loadCustomFields(true)).find((f) => f.name === FIELD_NAME && f.modality === 'account');
if (!field) {
  console.error(`No account field named "${FIELD_NAME}". Run provision-apollo-fields.mjs with APPLY=1 first.`);
  process.exit(1);
}
console.log(`writing into "${FIELD_NAME}" (${field.type}, max ${field.maxLength ?? '—'})\n`);

const s = getServiceSupabase();

// Paged: PostgREST caps a response at 1000 rows, and a silent truncation here
// would under-report a company's portfolio as complete.
const PAGE = 1000;
const rows = [];
for (let p = 0; p < 200; p += 1) {
  const { data, error } = await s
    .from('canonical_projects')
    .select(
      'apollo_account_id, apollo_account_name, company_name_raw, canonical_name, project_type, current_phase, estimated_value, estimated_value_currency, priority_band, priority_score, city, state_province, country, trigger_event, construction_start_date, estimated_completion_date, contact_name, additional_contacts, apollo_exported_at'
    )
    .not('apollo_account_id', 'is', null)
    .order('id', { ascending: true })
    .range(p * PAGE, (p + 1) * PAGE - 1);
  if (error) {
    console.error('query failed:', error.message);
    process.exit(1);
  }
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < PAGE) break;
}

const byAccount = new Map();
for (const r of rows) {
  const list = byAccount.get(r.apollo_account_id) ?? [];
  list.push(r);
  byAccount.set(r.apollo_account_id, list);
}
console.log(`${rows.length} project(s) across ${byAccount.size} resolved account(s)\n`);
if (byAccount.size === 0) {
  console.log('Nothing to write. apollo_account_id is unset on every record — account resolution has to run first.');
  process.exit(0);
}

let written = 0;
let unchanged = 0;
let failed = 0;

for (const [accountId, list] of byAccount) {
  const company = list.find((r) => r.apollo_account_name)?.apollo_account_name ?? list[0].company_name_raw ?? 'Unknown company';
  const text = renderAccountProjects(company, list);
  if (!text) continue;

  const res = await fetch(`https://api.apollo.io/api/v1/accounts/${accountId}`, { headers: h });
  if (!res.ok) {
    failed += 1;
    console.log(`  MISSING ${company.slice(0, 42)} (account ${accountId} -> HTTP ${res.status})`);
    continue;
  }
  const account = (await res.json()).account ?? {};
  const current = (account.typed_custom_fields ?? {})[field.id] ?? null;
  if (current === text) {
    unchanged += 1;
    continue;
  }

  console.log(`  ${apply ? 'writing' : 'would write'} ${company.slice(0, 40).padEnd(40)} ${list.length} project(s), ${text.length} chars${text.length > ACCOUNT_ROLLUP_MAX ? ' TRUNCATED' : ''}`);
  if (!apply) continue;

  const put = await fetch(`https://api.apollo.io/api/v1/accounts/${accountId}`, {
    method: 'PUT',
    headers: h,
    // Name is required on this PUT, exactly as it is for custom fields — without
    // it Apollo answers "undefined method 'strip' for nil", which reads like a
    // server fault rather than a missing parameter.
    body: JSON.stringify({ name: account.name, typed_custom_fields: { [field.id]: text } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (put.ok) {
    written += 1;
  } else {
    failed += 1;
    console.log(`     FAILED -> HTTP ${put.status} ${(await put.text()).slice(0, 140)}`);
  }
}

console.log(`\n${apply ? 'written' : 'would write'}: ${apply ? written : byAccount.size - unchanged}   already current: ${unchanged}   failed: ${failed}`);
if (!apply) console.log('Re-run with APPLY=1 to write.');
