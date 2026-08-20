'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { toastTone } from '@/lib/status-colors';

/**
 * Toasts replace the inline "saved / failed" text that every panel used to
 * render next to its own button. Mounted once in the app shell; call
 * `useToast()` from any client component.
 */

export type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastApi {
  show: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  // Falling back to a no-op keeps a component usable outside the provider
  // (in isolation, or a test) instead of throwing at render time.
  return ctx ?? { show: () => {} };
}

const DISMISS_AFTER_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((message: string, tone: ToastTone = 'info') => {
    setToasts((current) => [...current, { id: Date.now() + Math.random(), message, tone }]);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDone={() => setToasts((c) => c.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div
      className={`animate-rise-in border-border-base bg-surface pointer-events-auto rounded-[12px] border border-l-4 px-4 py-3 shadow-[var(--shadow-overlay)] ${toastTone[toast.tone]}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-foreground text-sm">{toast.message}</p>
        <button onClick={onDone} className="text-subtle hover:text-foreground shrink-0 text-xs" aria-label="Dismiss">
          ✕
        </button>
      </div>
    </div>
  );
}
