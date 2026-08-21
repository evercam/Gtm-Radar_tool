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
  /**
   * Already stored identically, so not written.
   *
   * Reported rather than hidden, and for a specific reason: if this number comes
   * back near zero on a re-ingest, the comparison is not working and the whole
   * optimisation is a no-op that looks like a fix. It is the measurement that
   * proves the claim.
   */
  unchanged: number;
}

/**
 * The rows this source already holds, keyed by source id.
 *
 * Selects the columns the incoming batch would write rather than just the id,
 * because the id alone can only answer "insert or update" — it cannot answer "is
 * this write worth doing", which is the question that matters. A read of a few
 * hundred rows is far cheaper than several hundred updates, each of which writes a
 * new tuple and touches all 21 indexes on the table.
 *
 * Throws rather than degrading to an empty map. A silent failure here would look
 * like "nothing exists yet", which writes everything — slow, but correct. The
 * dangerous direction is the other one, so the code that can only be wrong safely
 * still refuses to guess.
 */
async function findExistingRows(
  client: Client,
  sourceKey: string,
  ids: string[],
  columns: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  const select = ['source_unique_id', ...columns.filter((c) => c !== 'source_unique_id')].join(',');
  for (let i = 0; i < ids.length; i += PROBE_CHUNK) {
    const { data, error } = await client
      .from('canonical_projects')
      .select(select)
      .eq('source_key', sourceKey)
      .in('source_unique_id', ids.slice(i, i + PROBE_CHUNK));
    if (error) throw new Error(`Could not check existing records: ${error.message}`);
    for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
      found.set(String(r.source_unique_id), r);
    }
  }
  return found;
}

/**
 * Is the stored value the same as the one we are about to write?
 *
 * ERRS TOWARD "DIFFERENT", ALWAYS.
 *
 * A wrong "different" costs one unnecessary write. A wrong "same" silently stops
 * persisting a real change, and the row goes stale with nothing in any log to say
 * so. Those are not comparable failures, so anything this function is not sure
 * about is reported as different.
 *
 * The normalisation exists because the two sides do not speak the same dialect:
 * the incoming record is JavaScript, the stored row is whatever PostgREST decoded
 * from Postgres. `null` and `undefined` mean the same absence here; a numeric
 * string and a number are the same number; and a date written as '2026-08-01'
 * comes back as '2026-08-01T00:00:00+00:00', which is the same instant and would
 * otherwise mark every dated row changed on every run — turning this whole
 * optimisation into an expensive no-op that looks like it works.
 */
export function sameStoredValue(incoming: unknown, stored: unknown): boolean {
  if (incoming === undefined || incoming === null) return stored === undefined || stored === null;
  if (stored === undefined || stored === null) return false;

  if (typeof incoming === 'number' || typeof stored === 'number') {
    const a = Number(incoming);
    const b = Number(stored);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }

  if (typeof incoming === 'boolean' || typeof stored === 'boolean') return Boolean(incoming) === Boolean(stored);

  if (typeof incoming === 'string' && typeof stored === 'string') {
    if (incoming === stored) return true;
    // Only treat them as instants when BOTH parse and at least one carries the
    // shape of a timestamp. "2000" is a year to a publisher and a valid Date to
    // JavaScript, and calling those equal would be exactly the silent-staleness
    // failure this function is built to avoid.
    const looksTemporal = (v: string) => /\d{4}-\d{2}-\d{2}/.test(v);
    if (looksTemporal(incoming) && looksTemporal(stored)) {
      const a = Date.parse(incoming);
      const b = Date.parse(stored);
      if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
    }
    return false;
  }

  // Arrays and json. Key order is not normalised: a reordered object is reported
  // as changed, which is the safe direction and costs one write.
  try {
    return JSON.stringify(incoming) === JSON.stringify(stored);
  } catch {
    return false;
  }
}

/** Every column this batch would write, so the probe fetches exactly those. */
function payloadColumns(records: CanonicalProjectInsert[]): string[] {
  const keys = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) keys.add(k);
  return [...keys];
}

/**
 * Would writing this record change anything?
 *
 * Only the keys the batch actually carries are compared. Columns the adapter does
 * not set — priority_score, assignee_id, apollo_exported_at and the rest of the
 * pipeline's own state — are untouched by the upsert, so a difference there is not
 * this write's business.
 */
function differsFromStored(incoming: CanonicalProjectInsert, stored: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(incoming)) {
    if (!sameStoredValue(value, stored[key])) return true;
  }
  return false;
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
  let unchanged = 0;
  const columns = payloadColumns(records);

  for (let i = 0; i < records.length; i += UPSERT_CHUNK) {
    const chunk = records.slice(i, i + UPSERT_CHUNK);
    const existing = await findExistingRows(
      client,
      sourceKey,
      chunk.map((r) => r.source_unique_id),
      columns
    );

    /*
      WRITE ONLY WHAT WOULD CHANGE.

      Every source re-fetches its whole window on every run, so most of a batch is
      identical to what is already stored. Upserting it anyway is not free: Postgres
      writes a new tuple for each row, marks the old one dead, and updates all 21
      indexes on the table. Fifteen sources doing that concurrently is what produced
      "canceling statement due to statement timeout" across a whole run, twice now.

      The read that makes this possible costs one round trip per hundred ids. The
      writes it avoids cost far more, and reads on this table measure healthy —
      193ms median — while concurrent writes are what falls over.

      A record whose comparison is uncertain is written, not skipped. See
      sameStoredValue: the failure that matters is silently keeping a stale row.
    */
    const toWrite: CanonicalProjectInsert[] = [];
    for (const record of chunk) {
      const stored = existing.get(record.source_unique_id);
      if (!stored) {
        inserted += 1;
        toWrite.push(record);
      } else if (differsFromStored(record, stored)) {
        updated += 1;
        toWrite.push(record);
      } else {
        unchanged += 1;
      }
    }

    if (toWrite.length === 0) continue;

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
    await writeChunk(client, toWrite, i, records.length);
  }

  return { inserted, updated, collapsed, unchanged };
}
