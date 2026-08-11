/**
 * The event log's pure rules: redaction, bounding, and what earns a row.
 *
 * Separate from the writer because the writer imports the service Supabase
 * client, which is server-only — so anything that imported it to reach
 * `redactText` would drag a server module into a client bundle, and the tests
 * could not load it at all.
 *
 * No I/O here, which is also what makes the redaction rules testable. A leak
 * into the event table is a second copy of the CRM under weaker access rules,
 * and it would not be noticed for years, so these rules get tests rather than a
 * careful read.
 */

/**
 * The event log — what the app did, kept where it can be read afterwards.
 *
 * The problem this solves is not "not enough logging". There is plenty of
 * console.warn. The problem is that console.warn goes to a serverless log
 * stream that nobody tails and that rolls off, so a failure is invisible while
 * it is happening and gone by the time anyone asks. Meanwhile the caller writes
 * `?? 0` and the page shows a zero, which reads as an answer.
 *
 * So: notable events go to a table. Two rules make that safe to leave on.
 *
 * FIRST — logging must never affect the thing being logged. Every write here is
 * best-effort and swallows its own errors. A logging failure that broke a page
 * would be a strictly worse bug than the one the log was added to catch. The
 * writes are also not awaited by the hot path where that matters.
 *
 * SECOND — not every event. A per-query row would put tens of thousands of rows
 * a day in the table and the interesting ones would be unfindable. Successful
 * work is logged only when it was slow; failures always are.
 *
 * The pure helpers are separated from the I/O so the redaction and threshold
 * rules can be tested without a database.
 */

/**
 * Coarse buckets, so the log can be read one concern at a time.
 *
 * A plain string is accepted at the boundary too — an unrecognised kind should
 * land rather than be dropped, since losing the event defeats the point.
 */
export type EventKind = 'query' | 'filter' | 'cron' | 'export' | 'enrich' | 'ingest' | 'auth' | 'mcp';

export interface AppEvent {
  kind: EventKind | string;
  /** Stable identifier, not a sentence — these are grouped and counted. */
  name: string;
  /** False for a failure. Omit for events that are neither, like a filter. */
  ok?: boolean | null;
  durationMs?: number | null;
  detail?: Record<string, unknown>;
  /** Who caused it. Omit for scheduled work, which has no user. */
  actor?: string | null;
}

/**
 * Above this, a successful operation is worth a row.
 *
 * Two seconds because that is roughly where a page stops feeling like it
 * loaded. Below it, a slow query is not yet a problem worth a permanent record.
 */
export const SLOW_MS = 2_000;

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

/*
  Error text quotes its input. An enrichment failure will happily include the
  contact it was working on, and a filter can carry a search term that is
  somebody's email address. Both would put contact details in a table with
  weaker access rules than the records themselves — a second copy of the CRM,
  which is the sort of thing that is discovered years later.

  So this redacts on the way in rather than on the way out. Redacting at read
  time would mean the details were stored, and stored is the part that matters.
*/
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/*
  Phone-shaped runs, as three narrow alternatives rather than one loose one.

  The loose version — a digit followed by six or more of [digits, spaces,
  brackets, dots, dashes] — also matched a space-separated list of numbers, so
  an error message reading "tiers 209 24016 59054" came out as "tiers [phone]".
  That makes the log less readable in exchange for redacting something that was
  never a phone number, and an unreadable log is the problem this file exists to
  fix. Numeric JSON values are never scanned at all, so durations and row counts
  are unaffected either way; this is only about digits inside text.

  The three cases that are actually phone numbers here:
    +353 1 234 5678   — international; the leading + is what makes the spaces safe
    353-1-234-5678    — separated by dashes or dots, any number of groups
    35312345678       — contiguous, seven or more

  This roster works several countries and the numbers are not uniform, so the
  The dashed alternative repeats its group rather than fixing three of them. A
  fixed three matched only "353-1-234" out of "353-1-234-5678" and left the last
  group behind, so the redaction printed "[phone]-5678" — which leaks the tail it
  was supposed to remove.

  patterns stay shape-based rather than trying to validate a country's format.
  Foreign numbers are kept as data elsewhere in this app and must not be treated
  as errors; here they are redacted for the same reason local ones are.
*/
const PHONE_RE = /\+\d[\d\s().-]{5,}\d|\d{2,4}(?:[-.]\d{1,4}){2,}|\d{7,}/g;

/**
 * Emails and phone-shaped runs replaced, in any string.
 *
 * Applied on the way IN, not on the way out. Redacting at read time would mean
 * the details were stored, and stored is the part that matters.
 */
export function redactText(value: string): string {
  return (
    value
      .replace(EMAIL_RE, '[email]')
      /*
        The shape has to match AND there have to be enough digits. "1-2-3" fits
        the dashed alternative and is not a phone number, so the digit count is
        checked after the shape rather than being encoded into it.
      */
      .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 7 ? '[phone]' : m))
  );
}

/** How long a single string in `detail` may be. Error text can be enormous. */
const MAX_STRING = 500;
/** How deep to walk. Guards against a cyclic or absurdly nested object. */
const MAX_DEPTH = 4;
/** How many keys or array items to keep at each level. */
const MAX_KEYS = 40;

/**
 * Redact, truncate and flatten a detail object so it is safe and bounded.
 *
 * Bounded matters as much as safe: an unbounded jsonb column with an entire API
 * response in it turns the log into the largest table in the database.
 */
export function sanitiseDetail(input: unknown, depth = 0): unknown {
  if (input == null) return input;
  if (typeof input === 'string') {
    const clean = redactText(input);
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…[+${clean.length - MAX_STRING}]` : clean;
  }
  // Numbers and booleans pass through — they are the measurements.
  if (typeof input === 'number') return Number.isFinite(input) ? input : String(input);
  if (typeof input === 'boolean') return input;
  if (input instanceof Date) return input.toISOString();
  if (input instanceof Error) return sanitiseDetail({ error: input.message }, depth);

  if (depth >= MAX_DEPTH) return '[deep]';

  if (Array.isArray(input)) {
    const kept = input.slice(0, MAX_KEYS).map((v) => sanitiseDetail(v, depth + 1));
    return input.length > MAX_KEYS ? [...kept, `…[+${input.length - MAX_KEYS} more]`] : kept;
  }

  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (n >= MAX_KEYS) {
        out['…'] = 'truncated';
        break;
      }
      // Undefined keys are dropped rather than stored as null: a filter that was
      // not applied should be absent, not present-and-empty, or every event
      // carries the full filter vocabulary and the ones that were used are hard
      // to see.
      if (v === undefined) continue;
      out[k] = sanitiseDetail(v, depth + 1);
      n += 1;
    }
    return out;
  }

  // Functions, symbols, bigints.
  return String(input);
}

/* -------------------------------------------------------------------------- */
/* Sampling                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether an event earns a row.
 *
 * Failures always do — they are the reason the table exists. Successes only
 * when they were slow. Events with no outcome (a filter being applied) are kept,
 * because their value is the record that somebody looked, not that it worked.
 */
export function shouldRecord(event: AppEvent, slowMs: number = SLOW_MS): boolean {
  if (event.ok === false) return true;
  if (event.ok == null) return true;
  return (event.durationMs ?? 0) >= slowMs;
}

