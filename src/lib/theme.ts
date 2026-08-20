/**
 * The theme rule, in one file.
 *
 * There are necessarily two implementations of "is it dark right now": a string
 * that runs in <head> before any bundle exists, and a function the toggle calls.
 * The inline one cannot import the other — that is the whole point of it, it has
 * to run before first paint — so the duplication is unavoidable.
 *
 * What is avoidable is the two copies living in different files. They sat in
 * layout.tsx and ThemeToggle.tsx, and nothing would have caught them drifting:
 * a mismatch does not throw, it renders the wrong palette for one frame and then
 * corrects, which reads as a flicker somebody eventually files as "the toggle is
 * janky". Here they are adjacent, and test-theme.mjs asserts they agree.
 */

export type Theme = 'light' | 'dark' | 'system';

export const THEME_KEY = 'theme';

export const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Does the OS currently want dark? */
export function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

/** The stored preference, or 'system' when nothing is stored. */
export function storedTheme(): Theme {
  try {
    return (localStorage.getItem(THEME_KEY) as Theme) || 'system';
  } catch {
    // Private-mode Safari throws on localStorage access rather than returning
    // null. A theme is not worth a blank page.
    return 'system';
  }
}

/** Resolve a preference to a boolean. The runtime twin of the inline script. */
export function resolveDark(theme: Theme): boolean {
  return theme === 'dark' || (theme === 'system' && systemPrefersDark());
}

/**
 * Paint it.
 *
 * `colorScheme` alongside the class is what makes native widgets — scrollbars,
 * form controls, the space past the last row — follow the theme. Without it a
 * dark page keeps light scrollbars.
 */
export function applyDark(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

/** Read the stored preference and paint it. Idempotent. */
export function syncTheme(): void {
  applyDark(resolveDark(storedTheme()));
}

/**
 * The pre-paint bootstrap, inlined into <head>.
 *
 * Kept minimal and defensive: it runs before anything else, in a document where
 * a thrown error means an unstyled page. Every branch mirrors resolveDark above.
 */
export const THEME_BOOTSTRAP =
  `(function(){try{` +
  `var t=localStorage.getItem('${THEME_KEY}');` +
  `var d=t==='dark'||((!t||t==='system')&&matchMedia('${DARK_QUERY}').matches);` +
  `document.documentElement.classList.toggle('dark',d);` +
  `document.documentElement.style.colorScheme=d?'dark':'light';` +
  `}catch(e){}})();`;
