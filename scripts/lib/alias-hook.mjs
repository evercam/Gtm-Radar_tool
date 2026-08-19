/**
 * Lets scripts import the app's TypeScript modules directly under Node.
 *
 * Two gaps to close: the "@/..." path alias tsconfig maps to ./src/*, which
 * Node knows nothing about; and extensionless specifiers, which bundlers
 * resolve but Node's ESM loader does not.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '../../src');

function firstExisting(base) {
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const SERVER_ONLY_STUB = pathToFileURL(path.resolve(import.meta.dirname, 'server-only-stub.mjs')).href;
const NEXT_HEADERS_STUB = pathToFileURL(path.resolve(import.meta.dirname, 'next-headers-stub.mjs')).href;

export async function resolve(specifier, context, next) {
  // `server-only` throws outside a React Server Component. Under test that
  // would make every server module unimportable, including the pure functions
  // they contain, so it is swapped for a no-op.
  if (specifier === 'server-only') return next(SERVER_ONLY_STUB, context);
  // next/headers throws outside a request. The app already treats that as "no
  // session", so an empty stub exercises exactly the fallback path a script
  // should take.
  if (specifier === 'next/headers') return next(NEXT_HEADERS_STUB, context);

  /*
    `next/server` and friends, with the extension Node will not infer.

    Next ships no "exports" map, so a bare `next/server` resolves as a plain path
    to a file that does not exist — the real file is `next/server.js`. A bundler
    adds the extension; Node's ESM loader does not, which is the same gap this
    hook already closes for relative specifiers. Without this, any route handler
    is unimportable from a script, and the HTTP transport cannot be tested at all.
  */
  if (/^next\/[a-z-]+$/.test(specifier)) {
    const file = path.resolve(import.meta.dirname, '../../node_modules', `${specifier}.js`);
    if (existsSync(file)) return next(pathToFileURL(file).href, context);
  }

  if (specifier.startsWith('@/')) {
    const hit = firstExisting(path.join(SRC, specifier.slice(2)));
    return next(pathToFileURL(hit ?? path.join(SRC, `${specifier.slice(2)}.ts`)).href, context);
  }

  // Relative import from a file we already resolved into src/ — add the
  // extension the bundler would have inferred.
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !path.extname(specifier)) {
    const hit = firstExisting(path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier));
    if (hit) return next(pathToFileURL(hit).href, context);
  }

  return next(specifier, context);
}
