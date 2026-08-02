/**
 * Why does a Cleveland-Cliffs contact never get an address revealed?
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/probe-reveal-failure.mjs
 *
 * The full run found 12 contacts there and revealed 0, with nothing in the log —
 * `apolloRevealContacts` skips silently in three places and returns silently in a
 * fourth, so "0 revealed" is indistinguishable from "never tried". This reproduces
 * the call by hand and prints what Apollo actually says at each step.
 *
 * Spends up to 3 reveal credits.
 */

import { apolloFindContacts } from '@/lib/enrich/apollo.ts';
import { readSecret } from '@/lib/crypto/store';

const DOMAIN = 'clevelandcliffs.com';
const apiKey = await readSecret('apollo_api_key');

const contacts = await apolloFindContacts({ domain: DOMAIN, companyName: 'Cleveland-Cliffs Inc.', limit: 3 });
console.log(`${contacts.length} contacts from search\n`);
for (const c of contacts) {
  console.log(`  ${c.name} — id=${c.apolloPersonId ?? 'MISSING'} hasEmail=${c.hasEmail} email=${c.email ?? '-'}`);
}

for (const c of contacts) {
  if (!c.apolloPersonId) {
    console.log(`\n${c.name}: no person id — reveal would skip. THIS is the bug if it prints.`);
    continue;
  }
  const res = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ id: c.apolloPersonId, domain: DOMAIN, organization_name: 'Cleveland-Cliffs Inc.' }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  console.log(`\n${c.name}: HTTP ${res.status}`);
  if (!res.ok) {
    console.log(`  ${body.slice(0, 300)}`);
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.log(`  unparseable: ${body.slice(0, 200)}`);
    continue;
  }
  const p = parsed.person;
  if (!p) {
    // The silent branch. Apollo answered 200 and simply had nobody to return.
    console.log(`  200 but person=null. keys: ${Object.keys(parsed).join(', ')}`);
    console.log(`  ${body.slice(0, 300)}`);
    continue;
  }
  console.log(`  person: ${p.name ?? '?'}  email=${p.email ?? 'null'}  email_status=${p.email_status ?? '-'}`);
}
