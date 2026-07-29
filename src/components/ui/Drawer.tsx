'use client';

import { useEffect, type ReactNode } from 'react';

/**
 * Right-hand slide-over for record detail and search results — keeps the
 * user's list context instead of navigating away to a full page.
 *
 * Closes on Escape and on backdrop click, and restores body scroll on unmount.
 */
export default function Drawer({
  open,
  onClose,
  title,
  children,
  width = 'max-w-2xl',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <button
        className="animate-fade-in absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-label="Close"
        tabIndex={-1}
      />
      <div
        className={`animate-slide-in-right bg-surface relative flex h-full w-full ${width} flex-col shadow-[var(--shadow-overlay)]`}
      >
        <div className="border-border-base flex items-center justify-between gap-4 border-b px-5 py-3">
          <h2 className="text-foreground text-sm font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="text-subtle hover:text-foreground text-lg leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
