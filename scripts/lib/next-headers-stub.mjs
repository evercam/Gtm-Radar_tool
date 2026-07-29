/**
 * Stands in for `next/headers` when app modules are imported from a script.
 *
 * There is no request in a script, so both accessors throw in the real
 * implementation. Everything in the app already treats that as "no session" —
 * getRequestSupabase falls back to the service client, isCronRequest returns
 * false — so this returns empty rather than throwing, and the fallback paths
 * behave exactly as they would for an unauthenticated caller.
 */
const empty = {
  get: () => null,
  getAll: () => [],
  has: () => false,
  set: () => {},
  delete: () => {},
  entries: () => [][Symbol.iterator](),
  [Symbol.iterator]: () => [][Symbol.iterator](),
};

export async function cookies() {
  return empty;
}
export async function headers() {
  return empty;
}
export function draftMode() {
  return { isEnabled: false };
}
