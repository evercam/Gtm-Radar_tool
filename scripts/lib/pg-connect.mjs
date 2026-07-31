/**
 * A Postgres client that fails fast and says why.
 *
 * The scripts that use direct SQL built their own client with no timeouts, so a
 * Supabase pooler outage did not produce an error — it produced nothing. Both
 * owner-group scripts sat for over ten minutes with no output and no exit,
 * which reads as a hung script rather than an unreachable database, and there
 * was nothing to act on. That is the failure this exists to prevent.
 *
 * Defaults chosen so an outage costs seconds, not a coffee break:
 *   connect   10s — the pooler answers in under 500ms when healthy
 *   query     60s — generous, because these do read the whole table
 *
 * REST is the app's own transport and stays reliable when the pooler is not, so
 * a script that can be written against `@supabase/supabase-js` should be. This
 * is for the ones that genuinely want SQL — aggregates and bulk updates that
 * PostgREST cannot express without many round trips.
 */

import pg from 'pg';

/** Connects, or exits with a message naming the host and what to check. */
export async function connect({ connectTimeoutMs = 10_000, queryTimeoutMs = 60_000 } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Run with --env-file=.env.local.');
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: connectTimeoutMs,
    // Bounds a single statement, so a lock or a seq-scan on a big table gives
    // the run back instead of holding it open indefinitely.
    statement_timeout: queryTimeoutMs,
    query_timeout: queryTimeoutMs,
  });

  const host = url.replace(/^.*@/, '').replace(/\/.*$/, '');
  try {
    await client.connect();
  } catch (err) {
    const why = /timeout/i.test(err.message)
      ? 'it did not answer in time'
      : /ENOTFOUND|EAI_AGAIN/.test(err.message)
        ? 'the host does not resolve'
        : err.message;
    console.error(`Could not reach Postgres at ${host} — ${why}.`);
    console.error('');
    console.error('The pooler goes down independently of the REST API, so the app can be');
    console.error('fine while this is not. Things worth checking, in order:');
    console.error('  1. Supabase dashboard — is the project paused, or the pooler degraded?');
    console.error('  2. Connection count — an interrupted script can leave sessions open.');
    console.error('  3. DATABASE_URL port — 5432 is the session pooler, 6543 transactional.');
    process.exit(1);
  }

  return client;
}
