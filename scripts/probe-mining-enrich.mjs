/**
 * The real enrichment run, on the records that used to come back empty.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/probe-mining-enrich.mjs
 *
 * Everything before this proved a NAME resolves to a DOMAIN, which is not the
 * deliverable. This goes through `runEnrichment` itself — Claude, Apollo search,
 * committee assembly, reveal, validation, the write-back and the lifecycle move
 * — on the Cleveland-Cliffs subsidiaries from Ronniel's export.
 *
 * NOT read-only. It writes contacts and moves lifecycle stage on real records,
 * and every reveal costs an Apollo credit (capped by the policy's
 * maxEmailRevealsPerRecord). Scoped to the named records for that reason.
 *
 * The stored policy has Claude OFF; this passes an override rather than
 * flipping it, so the deployed app is unaffected by a local probe.
 */

import { getServiceSupabase } from '@/lib/supabase/server';
import { getEnrichmentPolicy } from '@/lib/policies';
import { runEnrichment } from '@/lib/enrich/run.ts';

const NAMES = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (NAMES.length === 0) NAMES.push('Hibbing Taconite Co', 'Tilden Mining Company LC', 'United Taconite LLC', 'Northshore Mining Company');

const service = getServiceSupabase();
const { config } = await getEnrichmentPolicy();
const policy = { ...config, engines: { ...config.engines, claude: true } };

const { data: rows, error } = await service
  .from('canonical_projects')
  .select(
    'id,canonical_name,record_type,icp_code,company_name_raw,contact_name,contact_email,contact_phone,description,city,state_province,country,estimated_value,estimated_value_currency,source_key,project_url,vertical'
  )
  .in('company_name_raw', NAMES)
  .order('id');
if (error) throw error;
console.log(`${rows.length} records\n`);

for (const r of rows) {
  const res = await runEnrichment(r, policy, {
    claude: true,
    apollo: true,
    fillCommittee: policy.fillCommittee,
    maxApolloCalls: null,
    maxClaudeCalls: null,
    overridden: true,
  });

  const withEmail = res.contacts.filter((c) => c.email).length;
  console.log(`${r.company_name_raw}`);
  console.log(`  ok=${res.ok}  account=${res.account?.name ?? '-'}  domain=${res.account?.domain ?? '-'}`);
  console.log(`  engines: claude=${res.engines.claude} apollo=${res.engines.apollo}`);
  console.log(`  ${res.contacts.length} contacts, ${withEmail} with a revealed email`);
  for (const c of res.contacts) {
    console.log(`    ${c.name ?? '?'} — ${c.title ?? '?'}  ${c.email ?? '(no email)'}`);
  }
  if (res.message) console.log(`  message: ${res.message}`);
  console.log('');
}
