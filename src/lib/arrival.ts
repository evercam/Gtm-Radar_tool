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
  /**
   * Further out than the selling window. Real, and worth revisiting — but a call
   * today is a call the buyer cannot act on.
   */
  | 'too_early'
  /** Starting inside the window. This is the one to call. */
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

/**
 * A duration a person would say out loud.
 *
 * "0.1 months ago" is arithmetically right and reads as a machine talking. These
 * strings end up in call briefs a rep reads before dialling and in the prompt the
 * model writes them from, so an awkward one propagates.
 */
function span(n: number): string {
  const a = Math.abs(n);
  if (a < 0.5) return 'less than two weeks';
  if (a < 1.5) return 'about a month';
  if (a < 18) return `${Math.round(a)} months`;
  const years = a / 12;
  return Number.isInteger(Math.round(years * 2) / 2) && Math.round(years * 2) % 2 !== 0
    ? `${Math.round(years * 2) / 2} years`
    : `${Math.round(years)} years`;
}

/**
 * A phase weight below this means the project is finished or dead. Taken from
 * the phase table rather than a list of strings, so an admin editing the table
 * moves this with it instead of the two disagreeing.
 */
const DEAD_BELOW = 0.15;

/*
  The selling window, in months before ground-breaking.

  Set by the team on 2026-08-13, and stated as a rule rather than left implicit in
  three comparisons:

    starting in more than 6 months   too_early  — real, but nothing to act on yet
    starting within 6 months         EARLY      — the window; this is the call
    already started, up to 3 months  late       — installable, the easy win is gone
    started more than 3 months ago   too_late   — the programme has moved on

  These were 1 and -2 months, which made "early" mean anything at all in the
  future — a project breaking ground in 2031 read the same as one starting in
  March. That is the difference between a call worth making and a call that wastes
  both people's time, and it is the single criterion this team ranks on.

  Named constants because the numbers are a business decision, not arithmetic:
  changing the window is editing these two lines.
*/
export const EARLY_WINDOW_MONTHS = 6;
export const LATE_WINDOW_MONTHS = 3;

export function arrivalFor(
  record: ArrivalInput,
  config: PriorityConfig = DEFAULT_PRIORITY_CONFIG,
  now: number = Date.now()
): Arrival {
  const { weight: phasePosition, label: phaseLabel, started } = phaseTiming(
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
  // A past start date on a phase that says work has not begun is a conflict, and
  // the phase wins. Observed: an "Awarded" project whose start date claimed
  // ground was broken seven years ago. The date is stale or belongs to an
  // earlier scheme; the curated phase is the better witness. Saying so beats
  // silently believing either one.
  if (toStart !== null && toStart < 0 && !started) {
    return {
      verdict: phasePosition >= 0.85 ? 'on_time' : 'early',
      phaseLabel,
      phasePosition,
      leadMonths: null,
      basis: 'phase_only',
      summary:
        `${phaseLabel ?? 'This phase'} — but the recorded start date is ${span(toStart)} in the past, ` +
        'which contradicts it. Treating the phase as correct.',
      dated: false,
    };
  }
  if (toStart !== null) {
    /*
      Read against the window above, not against zero. A start date far in the
      future is not a good lead — it is one to come back to.
    */
    const verdict: ArrivalVerdict =
      toStart > EARLY_WINDOW_MONTHS
        ? 'too_early'
        : toStart > 0
          ? 'early'
          : toStart > -LATE_WINDOW_MONTHS
            ? 'late'
            : 'too_late';
    const summary =
      toStart > EARLY_WINDOW_MONTHS
        ? `Too early — ${span(toStart)} before ground-breaking, outside the ${EARLY_WINDOW_MONTHS}-month window.`
        : toStart > 0
          ? `Early — breaking ground in ${span(toStart)}. This is the window.`
          : toStart > -LATE_WINDOW_MONTHS
            ? `Late — ground was broken ${span(toStart)} ago, but it is still installable.`
            : `Too late — ground was broken ${span(toStart)} ago.`;
    return { verdict, phaseLabel, phasePosition, leadMonths: toStart, basis: 'construction_start', summary, dated: true };
  }

  // A bid date is the next best thing to a start date: award precedes
  // mobilisation, so being ahead of it is being ahead of the work.
  const toBid = months(record.bid_date, now);
  if (toBid !== null && toBid > -1) {
    return {
      // Same window: an award a year out is no more actionable than a start date
      // a year out.
      verdict: toBid > EARLY_WINDOW_MONTHS ? 'too_early' : 'early',
      phaseLabel,
      phasePosition,
      leadMonths: toBid,
      basis: 'construction_start',
      summary: `Early — ${span(toBid)} before the bid date.`,
      dated: true,
    };
  }

  const toCompletion = months(record.estimated_completion_date, now);
  if (toCompletion !== null) {
    /**
     * A completion date means "months of build remaining" ONLY once building has
     * begun. Before that it is a target, and reading it as remaining build
     * produced the plainest contradiction this file has had: a project at
     * "Pre-Construction" reported as "Late — only 5 months of build left", on
     * 257 records. You cannot have five months of build left before you start.
     *
     * The phase decides the verdict; the date only says what they are aiming at.
     */
    if (!started) {
      return {
        verdict: phasePosition >= 0.85 ? 'on_time' : 'early',
        phaseLabel,
        phasePosition,
        leadMonths: toCompletion,
        basis: 'completion',
        summary:
          (phaseLabel ? `${phaseLabel[0].toUpperCase()}${phaseLabel.slice(1)}` : 'Not started') +
          (toCompletion > 0
            ? `, targeting completion in ${span(toCompletion)}. Build has not begun, so this is a target rather than time remaining.`
            : `, but the target completion date passed ${span(toCompletion)} ago — the record is out of date.`),
        dated: true,
      };
    }

    // Build remaining, not lead time — a different question, so labelled as one.
    const verdict: ArrivalVerdict =
      toCompletion <= 0 ? 'too_late' : toCompletion < 6 ? 'late' : 'on_time';
    const summary =
      toCompletion <= 0
        ? 'Too late — the completion date has passed.'
        : toCompletion < 6
          ? `Late — only ${span(toCompletion)} of build left.`
          : `${span(toCompletion)} of build remaining` + (phaseLabel ? `, ${phaseLabel}.` : '.');
    return { verdict, phaseLabel, phasePosition, leadMonths: toCompletion, basis: 'completion', summary, dated: true };
  }

  const sinceAnnounced = months(record.announced_date, now);
  // An announcement dated in the FUTURE has not happened. 652 records carry one,
  // because sources publish a year and the adapter stores 1 January of it. Taking
  // the absolute value turned "five months from now" into "announced five months
  // ago" — confidently backwards. Fall through to the phase instead.
  if (sinceAnnounced !== null && sinceAnnounced <= 0) {
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
        `Announced ${span(age)} ago` +
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
/**
 * Verdicts treated as COLD: not worth enriching, not worth sending to Apollo.
 *
 * `too_late` is uncontroversial — built, cancelled or retired, so there is
 * nothing to install.
 *
 * `late` is a deliberate business decision, not a technical one. The verdict
 * itself still means "mid-build, sellable, but the easy win is gone", and the
 * arrival chip will keep saying that. What changed is what we are willing to
 * SPEND on it: a mid-build project converts poorly enough that buying contacts
 * for it and putting it in front of a seller costs more than it returns. Called
 * on 12 August 2026.
 *
 * This is spend, not scope. Every record stays in the table, keeps its score, and
 * still says how late we are — a seller searching for it will find it, and
 * turning the decision around means changing this one array.
 */
export const COLD_ARRIVALS: readonly ArrivalVerdict[] = ['late', 'too_late'];

/**
 * Whether a record has arrived too late to be worth spending on.
 *
 * One predicate rather than a filter written at each call site, because the
 * enrichment queue, the assignment pass and the Apollo export must agree. If they
 * disagree, enrichment buys a contact the export then refuses to send — which is
 * the credit-burning shape this exists to prevent.
 *
 * `unknown` is NOT cold. An undated record with no phase has not been judged, and
 * treating unjudged as cold would silently drop everything a source ships without
 * dates.
 */
export function isColdArrival(record: ArrivalInput, config: PriorityConfig = DEFAULT_PRIORITY_CONFIG, now: number = Date.now()): boolean {
  return COLD_ARRIVALS.includes(arrivalFor(record, config, now).verdict);
}

/*
  Sort order: closest to the selling window first.

  `too_early` sits ABOVE `late` deliberately. A project starting in two years will
  enter the window; one that broke ground four months ago has left it and is not
  coming back. So of the two non-ideal states, the future one is worth more.
*/
export const ARRIVAL_ORDER: Record<ArrivalVerdict, number> = {
  early: 0,
  on_time: 1,
  too_early: 2,
  late: 3,
  too_late: 3,
  unknown: 4,
};
