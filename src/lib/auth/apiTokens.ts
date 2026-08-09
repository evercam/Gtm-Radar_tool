import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { permissionsForRole } from './roleStore';

/**
 * Bearer tokens for the HTTP MCP endpoint.
 *
 * A token is shown once and stored only as a SHA-256 hash, so a leaked database
 * yields hashes rather than working credentials and there is no "reveal" button
 * to misuse. It carries a ROLE rather than its own permission list, which means
 * narrowing a role narrows every token issued against it — one place to look
 * when asking what something may read.
 *
 * Deliberately not a JWT. A JWT would be verifiable without a database round
 * trip, and would therefore keep working for its full lifetime after being
 * revoked. Revocation matters more here than saving one indexed lookup.
 */

const PREFIX = 'gtm_';
/** How much of the token is stored in clear, purely so a row is recognisable. */
const VISIBLE = 10;

const missing = (m: string) => /does not exist|schema cache|relation/i.test(m);

export interface TokenRecord {
  id: string;
  name: string;
  tokenPrefix: string;
  role: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface TokenIdentity {
  id: string;
  name: string;
  role: string;
  /** Resolved from the role at verification time, never stored on the token. */
  permissions: string[];
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * Mints a token. The plaintext is returned once and never stored.
 *
 * 32 random bytes, base64url — 256 bits, which is well past anything guessable
 * and short enough to paste into a config file.
 */
export async function createToken(input: {
  name: string;
  role: string;
  createdBy?: string | null;
}): Promise<{ ok: boolean; message: string; token?: string }> {
  if (!input.name.trim()) return { ok: false, message: 'A token needs a name.' };
  if (!isSupabaseServiceConfigured()) return { ok: false, message: 'Supabase service key not configured.' };

  const secret = `${PREFIX}${randomBytes(32).toString('base64url')}`;
  const { error } = await getServiceSupabase().from('api_tokens').insert({
    name: input.name.trim(),
    token_hash: sha256(secret),
    token_prefix: secret.slice(0, VISIBLE),
    role: input.role,
    created_by: input.createdBy ?? null,
  });

  if (error) {
    if (missing(error.message)) return { ok: false, message: 'Run the api_tokens migration first.' };
    if (/foreign key/i.test(error.message)) return { ok: false, message: `No role named "${input.role}".` };
    return { ok: false, message: error.message };
  }
  return { ok: true, message: 'Token created. Copy it now — it cannot be shown again.', token: secret };
}

/**
 * Resolves a bearer token to an identity, or null.
 *
 * Compares hashes with a constant-time check. The lookup is by hash, so the
 * query itself already leaks nothing useful, but a plain === on the way back
 * would reintroduce a timing signal for free.
 */
export async function verifyToken(bearer: string | null | undefined): Promise<TokenIdentity | null> {
  if (!bearer) return null;
  const raw = bearer.replace(/^Bearer\s+/i, '').trim();
  if (!raw.startsWith(PREFIX) || raw.length < 20) return null;
  if (!isSupabaseServiceConfigured()) return null;

  try {
    const hash = sha256(raw);
    const { data, error } = await getServiceSupabase()
      .from('api_tokens')
      .select('id, name, role, token_hash, revoked_at')
      .eq('token_hash', hash)
      .is('revoked_at', null)
      .maybeSingle();
    if (error || !data) return null;

    const row = data as { id: string; name: string; role: string; token_hash: string; revoked_at: string | null };
    const a = Buffer.from(row.token_hash, 'utf8');
    const b = Buffer.from(hash, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    // Best-effort: a failed touch must not fail the request it is describing.
    void getServiceSupabase()
      .from('api_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', row.id)
      .then(
        () => undefined,
        () => undefined
      );

    return { id: row.id, name: row.name, role: row.role, permissions: await permissionsForRole(row.role) };
  } catch {
    return null;
  }
}

export async function listTokens(): Promise<{ tokens: TokenRecord[]; tableMissing: boolean }> {
  if (!isSupabaseServiceConfigured()) return { tokens: [], tableMissing: true };
  try {
    const { data, error } = await getServiceSupabase()
      .from('api_tokens')
      .select('id, name, token_prefix, role, created_at, last_used_at, revoked_at')
      .order('created_at', { ascending: false });
    if (error) return { tokens: [], tableMissing: missing(error.message) };
    return {
      tokens: (data ?? []).map((r: Record<string, unknown>) => ({
        id: r.id as string,
        name: r.name as string,
        tokenPrefix: r.token_prefix as string,
        role: r.role as string,
        createdAt: r.created_at as string,
        lastUsedAt: (r.last_used_at as string) ?? null,
        revokedAt: (r.revoked_at as string) ?? null,
      })),
      tableMissing: false,
    };
  } catch {
    return { tokens: [], tableMissing: true };
  }
}

/** Revokes without deleting, so the audit trail survives the revoke. */
export async function revokeToken(id: string): Promise<{ ok: boolean; message: string }> {
  if (!isSupabaseServiceConfigured()) return { ok: false, message: 'Supabase service key not configured.' };
  const { error } = await getServiceSupabase()
    .from('api_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: 'Token revoked. It stops working immediately.' };
}
