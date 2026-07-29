/**
 * Stands in for the `server-only` package under test.
 *
 * That package throws on import outside a React Server Component, which is
 * exactly right in the app and exactly wrong in a test runner — it would make
 * every server module untestable, including the pure functions inside them.
 * The guard protects the client bundle; nothing here ships.
 */
export {};
