'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Centred dialog with the three-part header / body / footer structure the
 * reference uses: identity and context in the header, fields in a scrollable
 * body, actions pinned at the bottom right.
 *
 * Focus is trapped while open and returned to whatever opened it on close —
 * without that, closing a modal drops keyboard users at the top of the page.
 */
export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'max-w-md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreTo.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusable = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );

    focusable()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      // Cycle within the dialog rather than escaping to the page behind it.
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <button className="absolute inset-0 cursor-default" onClick={onClose} aria-label="Close" tabIndex={-1} />

      <div
        ref={panelRef}
        className={`animate-rise-in border-border-base bg-surface relative flex max-h-[90vh] w-full ${width} flex-col overflow-hidden rounded-2xl border shadow-[var(--shadow-overlay)]`}
      >
        <div className="border-border-base flex items-start justify-between gap-4 border-b px-6 py-4">
          <div className="min-w-0">
            <p className="text-foreground text-sm font-bold">{title}</p>
            {subtitle ? <p className="text-muted mt-0.5 text-[11px]">{subtitle}</p> : null}
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:bg-surface-raised hover:text-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">{children}</div>

        {footer ? (
          <div className="border-border-base flex items-center justify-end gap-3 border-t px-6 py-4">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
