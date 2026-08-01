import type { CanonicalProjectInsert } from '@/lib/adapters/types';

/**
 * Collapses records that share a `source_unique_id`, keeping the first.
 *
 * A hard precondition of every upsert onto `(source_key, source_unique_id)`:
 * Postgres refuses an `ON CONFLICT DO UPDATE` whose own batch names the same
 * conflict target twice — "cannot affect row a second time" — and it refuses the
 * WHOLE statement, so one duplicated pair costs the entire page of records.
 *
 * Sources produce these routinely and for ordinary reasons: GEM publishes at
 * unit/phase grain while the id resolves to the site, and Find a Tender can
 * return the same notice twice inside one response. Both failed outright before
 * this — GEM on 11 of 18 files, Find a Tender on a scheduled run.
 *
 * First rather than last purely for determinism: re-running the same page must
 * produce the same row. Where duplicates represent genuinely distinct things, the
 * fix is the id the adapter chooses, not this function — collapsing here is the
 * floor that keeps the batch legal.
 */
export function dedupeBySourceUniqueId(records: CanonicalProjectInsert[]): {
  unique: CanonicalProjectInsert[];
  collapsed: number;
} {
  const seen = new Map<string, CanonicalProjectInsert>();
  for (const r of records) {
    if (!seen.has(r.source_unique_id)) seen.set(r.source_unique_id, r);
  }
  return { unique: [...seen.values()], collapsed: records.length - seen.size };
}
