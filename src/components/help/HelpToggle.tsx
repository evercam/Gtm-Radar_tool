import type { ReactNode } from 'react';

/**
 * A collapsible explainer.
 *
 * Built on native `<details>/<summary>` rather than a click handler and a piece
 * of state, which buys three things for nothing: it stays a SERVER component in
 * a file tree where the rest of the help page is server-rendered, it is
 * keyboard-operable and announced correctly without any ARIA, and the browser's
 * in-page find can open it to reveal a match. A styled div with an onClick has
 * none of that.
 *
 * For help text specifically, collapsed-by-default is the right posture. The
 * reasoning behind a filter matters enormously the first time somebody doubts a
 * result and is noise on every other visit, so it should be reachable in one
 * click and invisible until then.
 */
export default function HelpToggle({
  question,
  children,
  defaultOpen,
}: {
  /** Phrase this as the question somebody actually arrives with. */
  question: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className="border-border-base bg-surface-raised group rounded-lg border px-4 py-3 [&[open]>summary>span:last-child]:rotate-90"
    >
      <summary className="text-foreground flex cursor-pointer list-none items-center justify-between gap-3 text-[13px] font-semibold [&::-webkit-details-marker]:hidden">
        {question}
        {/* Rotates via the [&[open]] selector above — no state, no client JS. */}
        <span aria-hidden className="text-muted shrink-0 transition-transform duration-150">
          ›
        </span>
      </summary>
      <div className="text-body mt-2 space-y-2 text-xs leading-relaxed">{children}</div>
    </details>
  );
}
