/**
 * Raise each source's stored page size to what its vendor actually permits.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/apply-api-limits.mjs [--apply]
 *
 * The page size in `source_config` was 50 for almost everything — our own
 * conservative default, not a vendor limit. Socrata permits fifty thousand a
 * request. Asking for 50 costs the identical request and returns a fraction of
 * the payload.
 *
 * Only ever RAISES. A source already set above the recommendation is left alone:
 * somebody may have tuned it deliberately, and this script has no way to tell a
 * considered choice from an accident.
 *
 * Also clamps the run budget to a vendor's total-result ceiling where one exists,
 * because a budget above it does not fetch more — EDGAR pages happily to ten
 * thousand and then answers HTTP 200 with an error object in the body.
 *
 * Dry-run by default.
 */

import { getServiceSupabase } from '@/lib/supabase/server';
import { apiLimitFor, clampRunBudget } from '@/lib/sources/apiLimits';

const apply = process.argv.includes('--apply');
const service = getServiceSupabase();

const { data: rows, error } = await service
  .from('source_config')
  .select('slug, page_size, max_records_per_run')
  .order('slug');
if (error) {
  console.error(`Could not read source_config: ${error.message}`);
  process.exit(1);
}

const changes = [];
for (const r of rows ?? []) {
  const limit = apiLimitFor(r.slug);
  if (!limit) continue;

  const currentPage = r.page_size ?? 0;
  const currentBudget = r.max_records_per_run ?? 0;
  const nextPage = Math.max(currentPage, limit.recommendedPageSize);
  const nextBudget = clampRunBudget(r.slug, currentBudget);

  if (nextPage !== currentPage || nextBudget !== currentBudget) {
    changes.push({ slug: r.slug, currentPage, nextPage, currentBudget, nextBudget, verified: limit.verified });
  }
}

if (changes.length === 0) {
  console.log('Every source with a recorded limit is already at or above its recommendation.');
  process.exit(0);
}

console.log('slug'.padEnd(20) + 'page size'.padStart(18) + 'run budget'.padStart(20) + '   source');
for (const c of changes) {
  const page = c.nextPage !== c.currentPage ? `${c.currentPage} -> ${c.nextPage}` : String(c.currentPage);
  const budget = c.nextBudget !== c.currentBudget ? `${c.currentBudget} -> ${c.nextBudget}` : String(c.currentBudget);
  console.log(c.slug.padEnd(20) + page.padStart(18) + budget.padStart(20) + '   ' + (c.verified ? 'documented' : 'assumed'));
}

if (!apply) {
  console.log('\nDry run. Re-run with --apply.');
  process.exit(0);
}

for (const c of changes) {
  const { error: writeError } = await service
    .from('source_config')
    .update({ page_size: c.nextPage, max_records_per_run: c.nextBudget, updated_at: new Date().toISOString() })
    .eq('slug', c.slug);
  // Loudly. A half-applied pass would leave some sources fetching deep and others
  // shallow, with nothing recording which.
  if (writeError) {
    console.error(`\nFailed on ${c.slug}: ${writeError.message}`);
    process.exit(1);
  }
}
console.log(`\nUpdated ${changes.length} source(s). The next scheduled ingest uses them.`);
