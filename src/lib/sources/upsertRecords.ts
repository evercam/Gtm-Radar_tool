import 'server-only';
import type { getServiceSupabase } from '@/lib/supabase/server';
import type { CanonicalProjectInsert } from '@/lib/adapters/types';
import { dedupeBySourceUniqueId } from '@/lib/dedupeRecords';

/**
 * Writing a batch of source records to `canonical_projects`, safely at any size.
 *
 * This existed twice. The GEM path had chunking on both the write and the
 * existence probe, and a thrown error when the probe failed; the generic
 * `/api/ingest/[source]` path had none of it, because at fifty records a run
 * nothing was large enough to break. Raising the fetch depth broke four sources
 * on the first scheduled run — Glenigan, SEC EDGAR, NYC permits and Planning.ie
 * all died on "canceling statement due to statement timeout" — and each fix
 * needed had already been written months earlier in the other file.
 *
 * So there is now one of these, and both callers use it.
 */

type Client = ReturnType<typeof getServiceSupabase>;

/**
 * Rows per write.
 *
 * A single statement holding several hundred rows exceeds Postgres's statement
 * timeout. The failures were at 500 rows; 500 per CHUNK is fine because each is
 * its own statement.
 */
const UPSERT_CHUNK = 500;

/**
 * Ids per existence probe.
 *
 * The probe is a GET, so the ids travel in the URL — several hundred overran what
 * PostgREST accepts, the request failed, the error was discarded, and every row
 * counted as new. The data was still written correctly; only the numbers shown to
 * a human were wrong, which is the kind of bug that survives for a long time.
 */
const PROBE_CHUNK = 100;

export interface UpsertOutcome {
  inserted: number;
  updated: number;
  /** Dropped because an earlier row in the same batch claimed the same id. */
  collapsed: number;
}

/**
 * Which of these ids this source already holds.
 *
 * Throws rather than degrading to an empty set. A silent failure corrupts
 * nothing, it just reports a full re-ingest as thousands of new leads — and that
 * number is what somebody judges a run by.
 */
async function findExisting(client: Client, sourceKey: string, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += PROBE_CHUNK) {
    const { data, error } = await client
      .from('canonical_projects')
      .select('source_unique_id')
      .eq('source_key', sourceKey)
      .in('source_unique_id', ids.slice(i, i + PROBE_CHUNK));
    if (error) throw new Error(`Could not check existing records: ${error.message}`);
    for (const r of (data ?? []) as { source_unique_id: string }[]) found.add(r.source_unique_id);
  }
  return found;
}

/**
 * Deduplicate, count, and write — in chunks, with inserted-vs-updated accounting.
 *
 * The dedupe is a hard precondition, not a nicety: Postgres refuses an
 * `ON CONFLICT DO UPDATE` whose own batch names the same conflict target twice,
 * and it refuses the WHOLE statement, so one duplicated pair costs every record
 * in the chunk.
 */
export async function upsertSourceRecords(
  client: Client,
  sourceKey: string,
  input: CanonicalProjectInsert[]
): Promise<UpsertOutcome> {
  const { unique: records, collapsed } = dedupeBySourceUniqueId(input);
  let inserted = 0;
  let updated = 0;

  for (let i = 0; i < records.length; i += UPSERT_CHUNK) {
    const chunk = records.slice(i, i + UPSERT_CHUNK);
    const existing = await findExisting(
      client,
      sourceKey,
      chunk.map((r) => r.source_unique_id)
    );
    const newRows = chunk.filter((r) => !existing.has(r.source_unique_id)).length;
    inserted += newRows;
    updated += chunk.length - newRows;

    const { error } = await client
      .from('canonical_projects')
      .upsert(chunk, { onConflict: 'source_key,source_unique_id' });
    // Thrown with the chunk position, because "upsert failed" on a run of several
    // thousand tells you nothing about how much of it landed.
    if (error) {
      throw new Error(
        `Supabase upsert failed at records ${i}-${i + chunk.length} of ${records.length}: ${error.message}`
      );
    }
  }

  return { inserted, updated, collapsed };
}
