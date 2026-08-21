'use client';

import { useEffect, useState } from 'react';
import Logo from './Logo';

/**
 * The Evercam mark, waiting.
 *
 * Shown while a page is being rendered on the server. Several of this app's reads
 * are genuinely slow — the KPI summary pages a whole window, the BU rollup walks
 * the table — and a blank screen for eight seconds is indistinguishable from a
 * broken one.
 *
 * IT SAYS NOTHING FOR THE FIRST SECOND AND A HALF
 *
 * Most navigations are fast, and a message that flashes up and vanishes is worse
 * than no message: it makes a quick page feel like it struggled. So the mark
 * animates immediately and the words only arrive once the wait is long enough to
 * need explaining.
 *
 * WHAT IT SAYS ESCALATES, AND STAYS HONEST
 *
 * The lines are not encouragement. Each one tells the reader something true about
 * where they are — that the read is large, that it is past its usual time, that it
 * may be about to fail and what to do then. A spinner that cheerfully says
 * "Loading…" for thirty seconds has told nobody anything.
 *
 * The final line matters most. This app's statement timeout is around eight
 * seconds and its function budget is 240; a page that passes those is in trouble,
 * and the reader is the one who can decide to reload rather than wait.
 */

/** Elapsed ms → what is worth saying at that point. First match from the bottom wins. */
const STAGES = [
  { after: 1_500, line: 'Reading the pipeline…' },
  {
    after: 6_000,
    line: 'Still going — some of these reads walk the whole book.',
  },
  {
    after: 14_000,
    line: 'Longer than usual. It will either finish or tell you why it could not.',
  },
  {
    after: 28_000,
    line: 'This is past the time these queries normally take. Reloading is reasonable.',
  },
] as const;

export default function LoadingMark({
  /** Overrides the default copy where a caller knows what is actually slow. */
  label,
  className = '',
}: {
  label?: string;
  className?: string;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    /*
      A ticking clock rather than a chain of timeouts.

      One interval is cancelled cleanly on unmount, which matters here because this
      component is unmounted the instant the page it is waiting for arrives — and
      that is the common case, not the exception.
    */
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 500);
    return () => clearInterval(id);
  }, []);

  const stage = [...STAGES].reverse().find((s) => elapsed >= s.after);
  const message = label ?? stage?.line;

  return (
    <div
      className={`flex min-h-[40vh] flex-col items-center justify-center gap-4 ${className}`}
      /*
        Announced politely: the page is not ready, and a screen reader should hear
        that without having the rest of the document interrupted. `aria-live`
        rather than `role="alert"` for the same reason.
      */
      role="status"
      aria-live="polite"
    >
      <Logo variant="mark" width={40} className="animate-pulse-mark" />

      {/* The sweep. Underneath the mark, narrow, and carrying no percentage —
          it says busy, not "37% done", because nothing here knows that. */}
      <div className="bg-surface-raised border-border-base h-1 w-28 overflow-hidden rounded-full border">
        <div className="bg-brand/70 animate-sweep h-full w-1/3 rounded-full" />
      </div>

      {/*
        The height is reserved whether or not there is a message, so the mark does
        not jump upward the moment the first line appears.
      */}
      <p className="text-muted h-4 px-6 text-center text-[11px]">{message ?? ''}</p>
    </div>
  );
}
