import 'server-only';
import { Pool, type PoolClient } from 'pg';

/**
 * Direct Postgres, so RLS can be enforced against a session this app issued.
 *
 * PostgREST decides the caller's identity from a JWT signed by the Supabase
 * project. This project signs with ES256 and publishes only the public key, so
 * nothing here can mint a token it would accept — which is why sign-in cannot
 * go through PostgREST as an authenticated user at all.
 *
 * Connecting to Postgres directly sidesteps the token entirely. Inside a
 * transaction we switch to the `authenticated` role and set the same claim
 * PostgREST would have set, so `auth.uid()` resolves and every existing policy
 * applies unchanged. The database remains the boundary; only the way the
 * identity is delivered changed.
 *
 * Two details that are load-bearing:
 *
 *   * The role switch is what makes RLS bite. A policy is not evaluated for a
 *     table's owner, and the pooler connects as the owner — so querying
 *     without `set local role authenticated` would silently return everything.
 *   * `SET LOCAL` cannot take a parameter, so the claim goes through
 *     `set_config(..., true)` instead. String-building it would be an
 *     injection straight into the identity of the request.
 */

let pool: Pool | null = null;

export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
}

export function isDbConfigured(): boolean {
  return Boolean(databaseUrl());
}

export function getPool(): Pool {
  if (pool) return pool;

  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error(
      'Postgres is not configured: set DATABASE_URL in .env.local to the Supabase connection string (Project Settings → Database → Connection string).'
    );
  }

  pool = new Pool({
    connectionString,
    // Supabase terminates TLS with a certificate this chain does not verify
    // locally; the connection is still encrypted.
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // A pool that emits an unhandled 'error' takes the process down. A dropped
  // idle connection is routine — the pool replaces it.
  pool.on('error', () => {});

  return pool;
}

/**
 * Runs `fn` as the signed-in user, inside one transaction, with RLS applied.
 *
 * Everything the callback does is scoped: the role and the claim are set
 * LOCAL, so they are discarded when the transaction ends and cannot leak into
 * the next borrower of that pooled connection.
 */
export async function withUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    // Order matters: the claim has to be readable by the policies that run
    // under the switched role, and `set local role` cannot be undone by the
    // callback without ending the transaction.
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await client.query('set local role authenticated');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    try {
      await client.query('rollback');
    } catch {
      /* the connection is already gone; the pool will discard it */
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` with RLS bypassed, for work that has no user behind it —
 * ingestion, the scheduler, and the sign-in path itself. The equivalent of the
 * service-role key, and to be reached for as rarely.
 */
export async function withService<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Closes the pool. For scripts — a long-lived server should never call this. */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
