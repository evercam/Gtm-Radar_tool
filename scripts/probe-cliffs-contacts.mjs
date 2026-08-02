/**
 * Does the resolved parent actually carry contacts?
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/probe-cliffs-contacts.mjs
 *
 * Resolution is not the deliverable — a seller with a domain and nobody to call
 * is no better off than a seller with nothing. This runs the step after it, on
 * one of the five owners that used to resolve to nothing, to check the ladder
 * ends in people rather than just in a URL.
 *
 * Search only, no reveal: this asks whether Apollo holds decision-makers there,
 * which is the open question. Revealing their addresses costs a credit each and
 * is what the real run does after the committee is picked.
 */

import { apolloFindOrganization, apolloFindContacts } from '@/lib/enrich/apollo.ts';

const NAME = 'Hibbing Taconite Company';

const org = await apolloFindOrganization(NAME, 'Minnesota, United States', {
  useClaudeAliases: true,
  vertical: 'mining',
});
console.log(`${NAME}  ->  ${org?.domain ?? '(none)'}  [${org?.resolvedVia ?? '-'}]`);
if (!org?.domain) process.exit(1);

const contacts = await apolloFindContacts({
  domain: org.domain,
  companyName: org.name,
  limit: 5,
  fallbackPhone: org.phone,
});

console.log(`\n${contacts.length} contacts at ${org.domain}`);
for (const c of contacts) {
  console.log(`  ${c.name ?? '(no name)'} — ${c.title ?? '(no title)'}`);
  console.log(`      email available: ${c.hasEmail ? 'yes' : 'no'}   phone: ${c.phone ?? 'none'}`);
}
