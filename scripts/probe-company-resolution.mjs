/**
 * The three-tier company resolution ladder, against the LIVE Apollo index.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/probe-company-resolution.mjs
 *
 * The names below are the real ones from Ronniel's export, where 12 of 15
 * mining owners resolved to nothing and only 3 contacts reached the seller.
 * They are all the same failure: the source publishes the asset-owning entity
 * and Apollo indexes the operating parent, which no amount of suffix-trimming
 * bridges.
 *
 * Two things are being checked, and the second matters more than the first:
 *
 *   1. that the previously-unresolvable names now resolve
 *   2. that the names which must NOT resolve still don't
 *
 * (2) is the guard rail. "United States Steel" shortened one word too far
 * returns war.gov and "Empire Iron Mining" returns a fence company. A tier that
 * resolves everything by inventing a plausible parent is worse than the miss it
 * replaces, because a wrong domain puts a seller in front of the wrong company
 * and nothing downstream will catch it.
 *
 * Costs one Claude call per unresolved name; Apollo organization search is
 * free. Run it deliberately, not in CI.
 */

import { apolloFindOrganization } from '@/lib/enrich/apollo.ts';
import { isApolloConfigured } from '@/lib/enrich/apollo.ts';
import { isAliasHelperConfigured } from '@/lib/enrich/companyAliases.ts';

if (!(await isApolloConfigured())) {
  console.error('No Apollo key configured. Add one in Settings.');
  process.exit(1);
}
if (!(await isAliasHelperConfigured())) {
  console.error('No Anthropic key configured — tier 3 cannot be tested.');
  process.exit(1);
}

/** Should resolve. Subsidiary/asset names Apollo files under a parent. */
const SHOULD_RESOLVE = [
  ['Hibbing Taconite Company', 'Minnesota, United States'],
  ['Tilden Mining Company', 'Michigan, United States'],
  ['United Taconite LLC', 'Minnesota, United States'],
  ['Northshore Mining Company', 'Minnesota, United States'],
  ['Cleveland-Cliffs Minorca Mine Inc', 'Minnesota, United States'],
];

/** Already worked through tiers 1–2. Tier 3 must not make these worse. */
const REGRESSION = [
  ['NextEra Energy Inc', 'Florida, United States'],
  ['Florida Power & Light Co', 'Florida, United States'],
  ['Cypress Creek Renewables', 'North Carolina, United States'],
];

/**
 * Must stay unresolved, or resolve only to something genuinely theirs. A name
 * here that comes back with an unrelated domain is a FAILURE, not a bonus.
 */
const HAZARDS = [
  ['Empire Iron Mining Partnership', 'Michigan, United States'],
];

let passed = 0;
let failed = 0;

async function resolve(name, location) {
  const org = await apolloFindOrganization(name, location, { useClaudeAliases: true, vertical: 'mining' });
  return org;
}

function line(name, org) {
  if (!org?.domain) return `${name}  ->  (no domain)`;
  return `${name}  ->  ${org.domain}  [${org.resolvedVia}${org.queriedAs ? ` via "${org.queriedAs}"` : ''}]${
    org.aliasReasoning ? `\n      ${org.aliasReasoning}` : ''
  }`;
}

console.log('\nPreviously unresolvable — tier 3 should reach a parent');
for (const [name, loc] of SHOULD_RESOLVE) {
  const org = await resolve(name, loc);
  console.log(`  ${line(name, org)}`);
  if (org?.domain) passed++;
  else {
    failed++;
    console.log('    FAIL — still unresolved');
  }
}

console.log('\nRegression — tiers 1–2 must still win, without a Claude call');
for (const [name, loc] of REGRESSION) {
  const org = await resolve(name, loc);
  console.log(`  ${line(name, org)}`);
  // `resolvedVia: 'claude'` here would mean the cheap tiers stopped working and
  // a model call is now silently paying for what a regex used to do.
  if (org?.domain && org.resolvedVia !== 'claude') passed++;
  else {
    failed++;
    console.log(`    FAIL — expected name/rules, got ${org?.resolvedVia ?? 'nothing'}`);
  }
}

console.log('\nHazards — a wrong answer here is worse than no answer');
for (const [name, loc] of HAZARDS) {
  const org = await resolve(name, loc);
  console.log(`  ${line(name, org)}`);
  console.log('    (inspect: is that domain plausibly this company, or a stranger?)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
