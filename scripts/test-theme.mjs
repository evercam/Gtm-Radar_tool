/**
 * The theme switch, and the two implementations that must not disagree.
 *
 *   node --experimental-transform-types --no-warnings \
 *     --import ./scripts/lib/register-alias.mjs scripts/test-theme.mjs
 *
 * Three defects prompted this file, and none of them threw:
 *
 *   "system" was read once, in the pre-paint script, and never again. Nothing
 *     listened to the media query, so a tab left open across an automatic
 *     OS switch stayed in the old palette while the icon still said "system".
 *   a theme change in one tab notified the others but never repainted them, so
 *     the second tab's icon showed the new preference over the old colours —
 *     the one state where the control actively lies about what you see.
 *   the "is it dark" rule existed twice, in layout.tsx and ThemeToggle.tsx, in
 *     two different shapes. A drift there is not an error; it is one frame of
 *     the wrong palette, which gets filed as "the toggle feels janky".
 *
 * The last one is the reason this test runs the inline script for real rather
 * than grepping it. Both implementations are evaluated over every combination of
 * stored value and OS preference, and compared. A string that only LOOKS like the
 * function is exactly the bug.
 */

import { resolveDark, storedTheme, THEME_BOOTSTRAP, THEME_KEY, DARK_QUERY } from '@/lib/theme';
import { readFileSync } from 'node:fs';

let passed = 0,
  failed = 0;
const check = (n, c, d) => {
  if (c) {
    passed++;
    console.log(`  PASS ${n}`);
  } else {
    failed++;
    console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`);
  }
};
const group = (n) => console.log(`\n${n}`);

/**
 * Just enough DOM for both implementations to run.
 *
 * A real jsdom would be a dependency, and this codebase has none — the point is
 * to observe which class each rule lands on, and a classList that records a
 * boolean is sufficient for that.
 */
function makeEnv({ stored, systemDark }) {
  const root = {
    classList: {
      dark: false,
      toggle(name, on) {
        if (name === 'dark') root.classList.dark = on;
      },
    },
    style: { colorScheme: '' },
  };
  return {
    root,
    localStorage: {
      getItem: (k) => (k === THEME_KEY && stored !== undefined ? stored : null),
      setItem: () => {},
      removeItem: () => {},
    },
    matchMedia: (q) => ({
      matches: q === DARK_QUERY ? systemDark : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  };
}

/** Run the inline bootstrap against a fake document and report what it painted. */
function runBootstrap(env) {
  const fn = new Function('document', 'localStorage', 'matchMedia', THEME_BOOTSTRAP);
  fn({ documentElement: env.root }, env.localStorage, env.matchMedia);
  return { dark: env.root.classList.dark, colorScheme: env.root.style.colorScheme };
}

/** Run the module's rule against the same fake environment. */
function runModule(env) {
  const g = globalThis;
  const prevWindow = g.window;
  const prevLocal = g.localStorage;
  g.window = { matchMedia: env.matchMedia };
  g.localStorage = env.localStorage;
  try {
    return resolveDark(storedTheme());
  } finally {
    g.window = prevWindow;
    g.localStorage = prevLocal;
  }
}

const CASES = [];
for (const stored of [undefined, 'dark', 'light', 'system', 'nonsense', '']) {
  for (const systemDark of [true, false]) CASES.push({ stored, systemDark });
}

group('The inline script and the module agree on every input');
for (const c of CASES) {
  const label = `stored=${JSON.stringify(c.stored)} os=${c.systemDark ? 'dark' : 'light'}`;
  const boot = runBootstrap(makeEnv(c));
  const mod = runModule(makeEnv(c));
  check(label, boot.dark === mod, `script said ${boot.dark}, module said ${mod}`);
}

group('An explicit choice outranks the OS');
{
  check('stored dark stays dark under a light OS', runModule(makeEnv({ stored: 'dark', systemDark: false })) === true);
  check('stored light stays light under a dark OS', runModule(makeEnv({ stored: 'light', systemDark: true })) === false);
  check('system follows a dark OS', runModule(makeEnv({ stored: undefined, systemDark: true })) === true);
  check('system follows a light OS', runModule(makeEnv({ stored: undefined, systemDark: false })) === false);
}

group('colorScheme travels with the class, so native widgets follow');
{
  // Without this a dark page keeps light scrollbars and light form controls.
  check('dark sets colorScheme dark', runBootstrap(makeEnv({ stored: 'dark', systemDark: false })).colorScheme === 'dark');
  check(
    'light sets colorScheme light',
    runBootstrap(makeEnv({ stored: 'light', systemDark: true })).colorScheme === 'light'
  );
}

group('The toggle subscribes to both things that can change underneath it');
{
  const src = readFileSync('src/components/ThemeToggle.tsx', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  check('it listens for the OS preference changing', /matchMedia\(DARK_QUERY\)/.test(code));
  check('and registers a change handler on it', /addEventListener\('change'/.test(code));
  check('which is removed on unsubscribe', /removeEventListener\('change'/.test(code));
  check(
    'the OS handler defers to an explicit choice',
    /storedTheme\(\) !== 'system'/.test(code),
    'a stored light/dark must not be overridden by the OS'
  );

  check('it listens for another tab writing the preference', /addEventListener\('storage'/.test(code));
  check(
    'and REPAINTS on it rather than only re-rendering',
    /onStorage[\s\S]{0,200}syncTheme\(\)/.test(code),
    'notifying React without re-applying the class is the icon/colour mismatch'
  );

  check(
    'the rule is imported, not re-implemented',
    !/prefers-color-scheme/.test(code),
    'the media query string is back in the component — it belongs to lib/theme.ts'
  );
}

group('The layout no longer carries its own copy');
{
  const layout = readFileSync('src/app/layout.tsx', 'utf8');
  check('layout imports the shared bootstrap', /THEME_BOOTSTRAP/.test(layout));
  check(
    'layout defines no theme logic of its own',
    !/prefers-color-scheme/.test(layout),
    'a second copy of the rule is back in layout.tsx'
  );
  check('the bootstrap is still inlined into the document', /dangerouslySetInnerHTML/.test(layout));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
