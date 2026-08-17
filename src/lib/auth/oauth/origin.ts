import 'server-only';
import { headers } from 'next/headers';

/**
 * This deployment's origin, from the request.
 *
 * Route handlers get this free as `request.nextUrl.origin`; a page has no request
 * object, so it comes from the headers instead. Same value, and it has to be —
 * the `issuer` in the metadata document and the one the consent screen validates
 * a `resource` against must agree to the character, or a strict client rejects
 * the response for reasons it cannot explain.
 *
 * `x-forwarded-*` is trusted here, which is worth being deliberate about. Behind
 * Vercel these headers are set by the platform and cannot be spoofed by a
 * client; on a self-hosted deployment behind an untrusted proxy they could be, and
 * an attacker who controls them controls the issuer this server advertises. That
 * is survivable because nothing is authorized on the strength of the origin — it
 * decides only which URLs are printed back to the caller that supplied the host —
 * but it is the reason not to start authorizing anything on it later.
 */
export async function requestOrigin(): Promise<string> {
  const list = await headers();
  const host = list.get('x-forwarded-host') ?? list.get('host') ?? 'localhost:3000';
  const proto = list.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  return `${proto}://${host}`;
}
