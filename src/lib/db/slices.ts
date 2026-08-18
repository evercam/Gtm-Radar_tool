import 'server-only';

/**
 * Reading a whole table in parallel, without reading any row twice.
 *
 * Some questions genuinely need every row in JS rather than a SQL aggregate — the
 * KPI funnel and the routing preview both derive per-row state in TypeScript, and
 * re-expressing that logic in SQL would mean two definitions obliged to agree
 * forever. For those, the table has to cross the wire, and the only lever left is
 * how many round trips it takes.
 *
 * Keyset paging fixed the offset problem but is inherently SEQUENTIAL — each page
 * needs the previous page's last id — so 109,552 rows meant 110 round trips one
 * after another. Slicing the id space lets those run concurrently.
 *
 * Extracted here because lib/kpi.ts and lib/queries.ts both need it, and a uuid
 * partition duplicated in two files is exactly the drift this codebase keeps paying
 * for: the correctness argument below has to be true in one place, not remembered
 * in two.
 */

/**
 * Sixteen disjoint, exhaustive slices of the uuid space.
 *
 * THE CORRECTNESS ARGUMENT, because it is the whole basis for reading in parallel:
 * every uuid begins with one of sixteen hex digits, each slice covers exactly one of
 * them, so every row falls in exactly one slice. Bounds are `id > from` and
 * `id <= to` — half-open on the low side, so a boundary id belongs to one slice and
 * not two. The first slice has no lower bound and the last has no upper bound, so
 * nothing at either end escapes.
 *
 * Sixteen because v4 uuids are uniform, which puts ~1/16th of the table in each.
 * An uneven distribution would only unbalance the slices, never lose a row: coverage
 * comes from the bounds, not from the assumption about spread.
 */
export const ID_SLICES: readonly { from: string; to: string }[] = Array.from({ length: 16 }, (_, i) => {
  const boundary = (n: number) => `${n.toString(16)}0000000-0000-0000-0000-000000000000`;
  return {
    from: i === 0 ? '' : boundary(i),
    to: i === 15 ? '' : boundary(i + 1),
  };
});

/**
 * How many slices to read at once. MEASURED, not chosen.
 *
 * Against 109,552 rows in canonical_projects:
 *
 *   16 concurrent   52.3 s   4 of 16 slices FAILED,  98,002 of 109,552 rows
 *    6 concurrent   30.1 s   0 failed,              109,552 rows
 *    4 concurrent   37.8 s   0 failed,              109,552 rows
 *    1 (sequential) 101.6 s  0 failed,              109,552 rows
 *
 * The failures at sixteen are the important row. All of them at once saturates the
 * database and individual queries start exceeding the 8-second statement timeout
 * about four pages deep — so being greedy here does not trade speed for accuracy, it
 * trades a slow read for an incomplete one.
 */
export const SLICE_CONCURRENCY = 6;

/**
 * True for the read errors worth trying again.
 *
 * A statement timeout under concurrent load is transient by definition — the same
 * query on a quieter database succeeds, which is what the table above shows.
 * Anything else, a missing table or a bad column, fails identically on a second
 * attempt and retrying only doubles the wait before reporting it.
 */
export const isTransientReadError = (message: string) =>
  /statement timeout|canceling statement|57014|timeout/i.test(message);

/**
 * Runs `walk` once per slice with a bounded pool, returning results in slice order.
 *
 * A fixed pool rather than `Promise.all` over all sixteen: the concurrency is the
 * whole point of the measurement above, and mapping every slice at once is what
 * produced the timeouts. Workers pull the next slice as they finish, so
 * SLICE_CONCURRENCY requests are in flight and no more.
 */
export async function acrossSlices<T>(walk: (slice: { from: string; to: string }, index: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  let next = 0;

  await Promise.all(
    Array.from({ length: SLICE_CONCURRENCY }, async () => {
      while (next < ID_SLICES.length) {
        const index = next;
        next += 1;
        out[index] = await walk(ID_SLICES[index], index);
      }
    })
  );

  return out;
}
