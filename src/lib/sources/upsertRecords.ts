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

/**
 * The smallest chunk worth attempting.
 *
 * Below this the round trips cost more than the statement, and a timeout on a
 * single-figure batch is a real fault rather than a size problem — so it is
 * allowed to surface instead of being split forever.
 */
const MIN_CHUNK = 25;

const isTimeout = (message: string): boolean => /statement timeout|canceling statement|timeout/i.test(message);

/**
 * Write one chunk, halving and retrying if the statement times out.
 *
 * `position` and `total` are carried purely so the error names where in the run it
 * happened — "upsert failed" on a run of several thousand tells you nothing about
 * how much of it landed.
 */
async function writeChunk(
  client: Client,
  chunk: CanonicalProjectInsert[],
  position: number,
  total: number
): Promise<void> {
  const { error } = await client.from('canonical_projects').upsert(chunk, { onConflict: 'source_key,source_unique_id' });
  if (!error) return;

  if (isTimeout(error.message) && chunk.length > MIN_CHUNK) {
    const half = Math.ceil(chunk.length / 2);
    // Sequential, not parallel: the statement timed out because the database was
    // already working too hard, and two halves at once would make that worse.
    await writeChunk(client, chunk.slice(0, half), position, total);
    await writeChunk(client, chunk.slice(half), position + half, total);
    return;
  }

  throw new Error(
    `Supabase upsert failed at records ${position}-${position + chunk.length} of ${total}: ${error.message}` +
      (isTimeout(error.message) ? ` (already reduced to ${chunk.length} rows, so this is not a batch-size problem)` : '')
  );
}

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

    /*
      Written adaptively, because 500 is the right chunk for most publishers and
      too many for some.

      NYC DOB permits failed on the very first chunk with "canceling statement due
      to statement timeout" — 0 of 10,000 written, every run, so a working source
      produced nothing at all. Its rows are unusually wide: many populated columns
      plus a large raw_data payload, so 500 of them is far more work per statement
      than 500 Chicago rows.

      Halving the global chunk would slow every other source to fix one. Instead a
      timeout splits THAT chunk and retries, so the cost is paid only where it is
      needed and a new wide-rowed publisher fixes itself rather than failing.
    */
    await writeChunk(client, chunk, i, records.length);
  }

  return { inserted, updated, collapsed };
}
