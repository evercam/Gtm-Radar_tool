'use client';

import { useSyncExternalStore } from 'react';
import {
  DARK_QUERY,
  THEME_KEY,
  applyDark,
  resolveDark,
  storedTheme,
  syncTheme,
  type Theme,
} from '@/lib/theme';

/**
 * Light/dark toggle, persisted to localStorage and defaulting to the system
 * preference.
 *
 * The `.dark` class is applied to <html> by the inline script in the app shell,
 * so there is no flash of the wrong theme before hydration. This component
 * reads the stored value through useSyncExternalStore rather than syncing it
 * into state from an effect — the theme lives in localStorage, not in React.
 *
 * The two subscriptions below are what make "system" and "another tab" actually
 * work; both used to be missing in different ways.
 */

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);

  /*
    A theme change in ANOTHER tab has to repaint THIS one.

    `storage` fires only in the tabs that did not make the change, and the
    handler used to just notify React. So the icon in the other tab updated to
    the new preference while its colours stayed on the old one — the one state
    where the toggle actively lies about what you are looking at. It has to
    re-apply the class, not only re-render.
  */
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== THEME_KEY) return;
    syncTheme();
    onChange();
  };

  /*
    "System" has to keep meaning system.

    Nothing listened to the media query, so the OS preference was read exactly
    once — in the pre-paint script — and never again. Leave a tab open across
    sunset with macOS or Windows set to switch automatically and the app sits in
    the morning's palette until you reload it, while the icon still claims
    "system". This is the fix for that, and it deliberately fires only when the
    preference IS system: an explicit light or dark choice outranks the OS.
  */
  const mq = window.matchMedia(DARK_QUERY);
  const onSystemChange = () => {
    if (storedTheme() !== 'system') return;
    syncTheme();
    onChange();
  };

  window.addEventListener('storage', onStorage);
  mq.addEventListener('change', onSystemChange);

  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
    mq.removeEventListener('change', onSystemChange);
  };
}

function getSnapshot(): Theme {
  return storedTheme();
}

/** The server can't know the stored preference; the inline script corrects it. */
function getServerSnapshot(): Theme {
  return 'system';
}

function setTheme(next: Theme) {
  try {
    if (next === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage refused, so the choice cannot outlive the page. Still honour it
    // for this one — a toggle that visibly does nothing is worse than a toggle
    // that forgets.
  }

  applyDark(resolveDark(next));
  for (const notify of listeners) notify();
}

const ICONS: Record<Theme, string> = { light: '☀', dark: '☾', system: '◐' };
const NEXT: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' };

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const next = NEXT[theme];

  return (
    <button
      onClick={() => setTheme(next)}
      title={`Theme: ${theme} — switch to ${next}`}
      aria-label={`Theme: ${theme}. Switch to ${next}.`}
      className="rounded-lg px-2 py-1 text-base leading-none text-white/80 transition-colors hover:bg-white/10 hover:text-white"
    >
      {ICONS[theme]}
    </button>
  );
}
