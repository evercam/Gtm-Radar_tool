/**
 * How early are we arriving?
 *
 * Evercam gets installed at mobilisation. So the question that decides whether a
 * project is worth a call is not "is it a good project" but "where is it in its
 * life, and are we in front of it or behind it".
 *
 * Two signals, because no single one covers the book. Measured over the 2,378
 * in-scope records:
 *
 *   construction_start_date      11%   exact — months before ground-breaking
 *   estimated_completion_date    48%   how much build is left
 *   announced_date               66%   how stale the opportunity is
 *   phase only                  100%   position in the lifecycle
 *   no date at all               34%
 *
 * EVERY RESULT CARRIES ITS BASIS. "Seven months before ground-breaking" and
 * "announced three months ago" are different claims with different confidence,
 * and letting the weak one wear the strong one's clothes is the same defect as a
 * name beside somebody else's email address — it reads as certainty and a seller
 * acts on it. So the basis travels with the verdict, and the UI can show it.
 *
 * Derived, never stored: a pure function of columns that already exist, so there
 * is no migration, no backfill and nothing to go stale.
 */

import { phaseTiming, DEFAULT_PRIORITY_CONFIG, type PriorityConfig } from '@/lib/priority';

export type ArrivalVerdict =
  /** Ahead of the work. The window Evercam wants. */
  | 'early'
  /** Mobilising or just started — still installable, no time to waste. */
  | 'on_time'
  /** Mid-build. Sellable, but the easy win is gone. */
  | 'late'
  /** Built, cancelled or retired. Nothing to install. */
  | 'too_late'
  /** Not enough on the record to say. Said plainly rather than guessed. */
  | 'unknown';

export type ArrivalBasis =
  | 'construction_start'
  | 'completion'
  | 'announced'
  | 'phase_only'
  | 'none';

export interface Arrival {
  verdict: ArrivalVerdict;
  /** Human label from the phase table — "pre-construction — prime window". */
  phaseLabel: string | null;
  /** 0..1 from the phase weights. 1 is the moment of install. */
  phasePosition: number;
  /**
   * Months relative to the event named by `basis`. Positive means the event is
   * still ahead of us. Null when no date supports it.
   */
  leadMonths: number | null;
  basis: ArrivalBasis;
  /** One line, safe to render as-is. Always names the basis. */
  summary: string;
  /** True when `leadMonths` came from a date rather than an inference. */
  dated: boolean;
}

export interface ArrivalInput {
  current_phase?: string | null;
  record_type?: string | null;
  construction_start_date?: string | null;
  estimated_completion_date?: string | null;
  announced_date?: string | null;
  bid_date?: string | null;
}

const MS_PER_MONTH = 30.44 * 86_400_000;

function months(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round(((t - now) / MS_PER_MONTH) * 10) / 10;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${Math.abs(n) === 1 ? one : many}`;
}

/**
 * A phase weight below this means the project is finished or dead. Taken from
 * the phase table rather than a list of strings, so an admin editing the table
 * moves this with it instead of the two disagreeing.
 */
const DEAD_BELOW = 0.15;

export function arrivalFor(
  record: ArrivalInput,
  config: PriorityConfig = DEFAULT_PRIORITY_CONFIG,
  now: number = Date.now()
): Arrival {
  const { weight: phasePosition, label: phaseLabel } = phaseTiming(
    record.current_phase,
    record.record_type,
    config
  );
  const hasPhase = Boolean(record.current_phase?.toString().trim());

  // A company record is not a project and has no arrival. Saying so is more use
  // than a fabricated verdict — it tells someone this row needs a project
  // attached before it can be timed at all.
  if (!hasPhase && record.record_type === 'account') {
    return {
      verdict: 'unknown',
      phaseLabel: null,
      phasePosition,
      leadMonths: null,
      basis: 'none',
      summary: 'Company record — no project attached, so there is nothing to time.',
      dated: false,
    };
  }

  // Finished or dead settles it regardless of dates. A completion date in the
  // future on an Operating plant is a refurbishment date, not a build.
  if (hasPhase && phasePosition <= DEAD_BELOW) {
    return {
      verdict: 'too_late',
      phaseLabel,
      phasePosition,
      leadMonths: null,
      basis: 'phase_only',
      summary: phaseLabel ? `Too late — ${phaseLabel}.` : 'Too late — the work is finished or stopped.',
      dated: false,
    };
  }

  // Strongest first. Each branch says which date it used, so a weak basis never
  // reads as a strong one.
  const toStart = months(record.construction_start_date, now);
  if (toStart !== null) {
    const verdict: ArrivalVerdict = toStart > 1 ? 'early' : toStart > -2 ? 'on_time' : 'late';
    const summary =
      toStart > 1
        ? `Early — ${plural(toStart, 'month', 'months')} before ground-breaking.`
        : toStart > -2
          ? 'On time — mobilising now.'
          : `Late — ground was broken ${plural(Math.abs(toStart), 'month', 'months')} ago.`;
    return { verdict, phaseLabel, phasePosition, leadMonths: toStart, basis: 'construction_start', summary, dated: true };
  }

  // A bid date is the next best thing to a start date: award precedes
  // mobilisation, so being ahead of it is being ahead of the work.
  const toBid = months(record.bid_date, now);
  if (toBid !== null && toBid > -1) {
    return {
      verdict: 'early',
      phaseLabel,
      phasePosition,
      leadMonths: toBid,
      basis: 'construction_start',
      summary: `Early — ${plural(toBid, 'month', 'months')} before the bid date.`,
      dated: true,
    };
  }

  const toCompletion = months(record.estimated_completion_date, now);
  if (toCompletion !== null) {
    // Build remaining, not lead time — a different question, so labelled as one.
    const verdict: ArrivalVerdict =
      toCompletion <= 0 ? 'too_late' : toCompletion < 6 ? 'late' : phasePosition >= 0.85 ? 'on_time' : 'early';
    const summary =
      toCompletion <= 0
        ? 'Too late — the completion date has passed.'
        : toCompletion < 6
          ? `Late — only ${plural(toCompletion, 'month', 'months')} of build left.`
          : `${plural(toCompletion, 'month', 'months')} of build remaining` +
            (phaseLabel ? `, ${phaseLabel}.` : '.');
    return { verdict, phaseLabel, phasePosition, leadMonths: toCompletion, basis: 'completion', summary, dated: true };
  }

  const sinceAnnounced = months(record.announced_date, now);
  if (sinceAnnounced !== null) {
    const age = Math.abs(sinceAnnounced);
    // Age is not lead time. It only says how long this has been public, which is
    // a staleness signal — so the phase decides the verdict and the date only
    // colours it.
    const verdict: ArrivalVerdict = phasePosition >= 0.85 ? 'on_time' : 'early';
    return {
      verdict,
      phaseLabel,
      phasePosition,
      leadMonths: sinceAnnounced,
      basis: 'announced',
      summary:
        `Announced ${plural(age, 'month', 'months')} ago` +
        (phaseLabel ? `, ${phaseLabel}` : '') +
        '. No build dates published, so how early we are is inferred from the phase.',
      dated: true,
    };
  }

  if (hasPhase) {
    return {
      verdict: phasePosition >= 0.85 ? 'on_time' : 'early',
      phaseLabel,
      phasePosition,
      leadMonths: null,
      basis: 'phase_only',
      summary: phaseLabel
        ? `${phaseLabel} — no dates published, so this is the phase only.`
        : 'Phase recorded but unrecognised, and no dates published.',
      dated: false,
    };
  }

  return {
    verdict: 'unknown',
    phaseLabel: null,
    phasePosition,
    leadMonths: null,
    basis: 'none',
    summary: 'No phase and no dates on this record — nothing to time it by.',
    dated: false,
  };
}

/** Sort key: earliest arrival first, undated after dated at the same verdict. */
export const ARRIVAL_ORDER: Record<ArrivalVerdict, number> = {
  early: 0,
  on_time: 1,
  late: 2,
  too_late: 3,
  unknown: 4,
};
