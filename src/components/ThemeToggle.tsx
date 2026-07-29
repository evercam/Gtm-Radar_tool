'use client';

import { useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark' | 'system';

/**
 * Light/dark toggle, persisted to localStorage and defaulting to the system
 * preference.
 *
 * The `.dark` class is applied to <html> by the inline script in the app shell,
 * so there is no flash of the wrong theme before hydration. This component
 * reads the stored value through useSyncExternalStore rather than syncing it
 * into state from an effect — the theme lives in localStorage, not in React.
 */

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function getSnapshot(): Theme {
  return (localStorage.getItem('theme') as Theme) || 'system';
}

/** The server can't know the stored preference; the inline script corrects it. */
function getServerSnapshot(): Theme {
  return 'system';
}

function applyTheme(next: Theme) {
  if (next === 'system') localStorage.removeItem('theme');
  else localStorage.setItem('theme', next);

  const dark = next === 'dark' || (next === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';

  for (const notify of listeners) notify();
}

const ICONS: Record<Theme, string> = { light: '☀', dark: '☾', system: '◐' };
const NEXT: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' };

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const next = NEXT[theme];

  return (
    <button
      onClick={() => applyTheme(next)}
      title={`Theme: ${theme} — switch to ${next}`}
      aria-label={`Theme: ${theme}. Switch to ${next}.`}
      className="rounded-lg px-2 py-1 text-base leading-none text-white/80 transition-colors hover:bg-white/10 hover:text-white"
    >
      {ICONS[theme]}
    </button>
  );
}
