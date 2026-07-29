/**
 * Enrichment queue eligibility — the filter clauses, mirrored from source.
 *
 * The enrichment policy is a promise about what will be spent on. It said
 * "P1 and P2 only" while the queue enforced nothing but a score floor, so
 * 1,172 P3 records were eligible and billable — 83% more than the policy
 * allowed, with nothing anywhere reporting the gap.
 *
 * This asserts the clause exists and that the two callers that matter both
 * pass it. A filter nobody passes is the same as no filter.
 *
 *   node --no-warnings scripts/test-queue-filters.mjs
 */

import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const group = (n) => console.log(`\n${n}`);

const queries = readFileSync('src/lib/queries.ts', 'utf8');
const batch = readFileSync('src/app/api/enrich/batch/route.ts', 'utf8');
const page = readFileSync('src/app/control/enrichment/page.tsx', 'utf8');

const filterFn = queries.match(/function applyQueueFilters[\s\S]*?\n\}/)?.[0] ?? '';

group('The band list is a real clause on the enrichment queue');
{
  const iface = queries.match(/export interface EnrichQueueFilters \{[\s\S]*?\n\}/)?.[0] ?? '';
  check('EnrichQueueFilters declares bands', /bands\?: string\[\]/.test(iface), iface.slice(0, 80));
  check('applyQueueFilters uses it', /f\.bands\?\.length/.test(filterFn));
  check('as an IN over priority_band', /q\.in\('priority_band', f\.bands\)/.test(filterFn));
}

group('A single band still narrows, and does not replace the list');
{
  check('the singular clause survives', /f\.band\b[\s\S]{0,60}eq\('priority_band', f\.band\)/.test(filterFn));
  const bandsAt = filterFn.indexOf('f.bands');
  const bandAt = filterFn.indexOf("eq('priority_band', f.band)");
  check('the list is applied before the narrowing', bandsAt > -1 && bandAt > bandsAt, `${bandsAt} vs ${bandAt}`);
}

group('Both callers pass it — a filter nobody passes is no filter');
check('the batch endpoint passes the policy bands', /bands: policy\.bands/.test(batch));
check('the queue preview passes the policy bands', /bands: policy\.bands/.test(page));

group('The preview counts what the batch would run');
{
  // Every eligibility clause the batch sends must also reach the preview, or
  // the page advertises a queue the run would never work.
  for (const clause of ['bands', 'recordTypes', 'bus', 'verticals', 'minEstimatedValue', 'requireCompany', 'minPriority', 'reenrichAfterDays', 'onlyMissingContact']) {
    check(`both send ${clause}`, batch.includes(`${clause}:`) && page.includes(`${clause}:`), `batch=${batch.includes(clause + ':')} page=${page.includes(clause + ':')}`);
  }
}

group('A caller can never widen past the policy');
check('a requested band must be in the policy list', /policy\.bands\.includes\(body\.band\)/.test(batch));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
