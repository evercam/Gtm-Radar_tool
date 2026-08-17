import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Credential handling shared by every table in this subsystem.
 *
 * Three functions, in one place, because the alternative is four modules each
 * with their own nearly-identical comparison and one of them eventually using
 * `===`. Same storage rule as api_tokens: what goes in the database is the
 * SHA-256 of the secret and never the secret.
 */

/** 32 bytes of randomness behind a recognisable prefix. */
export function mintSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Constant-time string comparison.
 *
 * Length is checked first and separately: `timingSafeEqual` THROWS on
 * mismatched lengths, and a throw where a false belongs is itself the timing
 * oracle the function exists to remove.
 */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * PKCE verification, RFC 7636 §4.6.
 *
 * BASE64URL(SHA256(verifier)) against the stored challenge. The digest is taken
 * over the ASCII of the verifier, not over decoded bytes — the verifier is
 * already a printable string by definition and treating it as base64 would
 * silently succeed for some inputs and fail for others.
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  // RFC 7636 §4.1: 43–128 characters from an unreserved set. A verifier shorter
  // than 43 characters has less entropy than the mechanism assumes, so it is
  // refused rather than hashed.
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;

  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return sameSecret(computed, challenge);
}
