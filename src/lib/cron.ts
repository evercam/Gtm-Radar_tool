/**
 * Cron expressions: matching, building, reading back, and describing.
 *
 * Pure and dependency-free so the same code decides whether a schedule is due
 * on the server and what the picker shows in the browser. Keeping them
 * together is the point — a builder that emits an expression the matcher does
 * not understand produces a schedule that silently never fires.
 *
 * Everything here is UTC. A schedule that drifts with the viewer's timezone
 * would run at a different hour depending on who last looked at it.
 */

/** The subset the schedule picker emits and the matcher understands. */
export type Frequency = 'every_15_min' | 'hourly' | 'daily' | 'weekdays' | 'days' | 'custom';

export interface ScheduleParts {
  frequency: Frequency;
  /** UTC hour 0–23. Used by daily, weekdays and weekly. */
  hour: number;
  /** UTC minute 0–59. Used by hourly, daily, weekdays and weekly. */
  minute: number;
  /**
   * Days of the week, 0 = Sunday. Used by `days`, which covers both "every
   * Monday" and "Monday, Wednesday and Friday" — a single control instead of
   * two, since one selected day is just the narrow case.
   */
  weekdays: number[];
  /**
   * A saved expression the widgets cannot express. Read-only in the picker:
   * there is no text box, so this only ever holds something set before the
   * widgets covered it, or by hand in the database.
   */
  expression: string;
}

export const DEFAULT_SCHEDULE: ScheduleParts = {
  frequency: 'daily',
  hour: 4,
  minute: 0,
  weekdays: [1],
  expression: '0 4 * * *',
};

export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Whether a cron expression matches this moment.
 *
 * A deliberately small implementation covering the subset the picker emits:
 * `*`, a number, a comma list, a range, and `*​/n`. Anything richer would need
 * a real parser, and a schedule the picker cannot express is a schedule nobody
 * can see or edit.
 */
export function cronMatches(expression: string, at: Date = new Date()): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const fields = [at.getUTCMinutes(), at.getUTCHours(), at.getUTCDate(), at.getUTCMonth() + 1, at.getUTCDay()];

  return parts.every((part, i) => {
    const value = fields[i];
    if (part === '*') return true;

    return part.split(',').some((token) => {
      if (token.startsWith('*/')) {
        const step = Number(token.slice(2));
        return Number.isFinite(step) && step > 0 && value % step === 0;
      }
      if (token.includes('-')) {
        const [lo, hi] = token.split('-').map(Number);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
        // Sunday is both 0 and 7, so a range like 1-5 never wraps in practice.
        return value >= lo && value <= hi;
      }
      const n = Number(token);
      // Cron treats both 0 and 7 as Sunday.
      if (i === 4 && n === 7) return value === 0;
      return Number.isFinite(n) && n === value;
    });
  });
}

/** Five-field shape check — the only thing the save endpoint can verify cheaply. */
export function isValidCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^(\*|\d+|\*\/\d+|\d+-\d+|(\d+,)+\d+)$/.test(p));
}

/** Picker state → expression. */
export function buildCron(parts: ScheduleParts): string {
  const m = clamp(parts.minute, 0, 59);
  const h = clamp(parts.hour, 0, 23);
  switch (parts.frequency) {
    case 'every_15_min':
      return '*/15 * * * *';
    case 'hourly':
      return `${m} * * * *`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekdays':
      return `${m} ${h} * * 1-5`;
    case 'days': {
      // Sorted and de-duplicated so the same selection always produces the
      // same expression — otherwise a saved schedule looks changed when it is
      // not, and the editor reports itself dirty.
      const days = Array.from(new Set(parts.weekdays.map((d) => clamp(d, 0, 6)))).sort((a, b) => a - b);
      return days.length ? `${m} ${h} * * ${days.join(',')}` : `${m} ${h} * * *`;
    }
    case 'custom':
      return parts.expression.trim();
  }
}

/**
 * Expression → picker state, so an existing schedule opens on the control that
 * produced it rather than dropping the user into the raw-expression escape
 * hatch.
 */
export function parseCron(expression: string | null | undefined): ScheduleParts {
  const expr = (expression ?? '').trim();
  if (!expr) return { ...DEFAULT_SCHEDULE, expression: '' };

  const custom: ScheduleParts = { ...DEFAULT_SCHEDULE, frequency: 'custom', expression: expr };
  const [min, hr, dom, mon, dow] = expr.split(/\s+/);
  if (!dow || dom !== '*' || mon !== '*') return custom;

  if (min === '*/15' && hr === '*' && dow === '*') return { ...DEFAULT_SCHEDULE, frequency: 'every_15_min', expression: expr };

  const m = Number(min);
  if (!Number.isInteger(m) || m < 0 || m > 59) return custom;

  if (hr === '*' && dow === '*') return { ...DEFAULT_SCHEDULE, frequency: 'hourly', minute: m, expression: expr };

  const h = Number(hr);
  if (!Number.isInteger(h) || h < 0 || h > 23) return custom;

  if (dow === '*') return { ...DEFAULT_SCHEDULE, frequency: 'daily', hour: h, minute: m, expression: expr };
  if (dow === '1-5') return { ...DEFAULT_SCHEDULE, frequency: 'weekdays', hour: h, minute: m, expression: expr };

  // One day or a comma list — both are the same control.
  const days = dow.split(',').map(Number);
  if (days.length > 0 && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 7)) {
    const normalised = Array.from(new Set(days.map((d) => (d === 7 ? 0 : d)))).sort((a, b) => a - b);
    return { ...DEFAULT_SCHEDULE, frequency: 'days', hour: h, minute: m, weekdays: normalised, expression: expr };
  }
  return custom;
}

/** Plain-English rendering, so a schedule can be checked without reading cron. */
export function describeCron(expression: string | null | undefined): string {
  const expr = (expression ?? '').trim();
  if (!expr) return 'no schedule — runs only when triggered by hand';
  if (!isValidCron(expr)) return `invalid expression "${expr}" — this will never run`;

  const p = parseCron(expr);
  const at = `${pad(p.hour)}:${pad(p.minute)} UTC`;
  switch (p.frequency) {
    case 'every_15_min':
      return 'every 15 minutes';
    case 'hourly':
      return `every hour, at ${pad(p.minute)} past`;
    case 'daily':
      return `every day at ${at}`;
    case 'weekdays':
      return `Monday to Friday at ${at}`;
    case 'days': {
      const names = p.weekdays.map((d) => WEEKDAY_LABELS[d]);
      if (names.length === 0) return `every day at ${at}`;
      if (names.length === 1) return `every ${names[0]} at ${at}`;
      const last = names[names.length - 1];
      return `every ${names.slice(0, -1).join(', ')} and ${last} at ${at}`;
    }
    case 'custom':
      return `on the schedule "${expr}"`;
  }
}

/**
 * The next moment this expression fires, or null if it cannot fire within a
 * year. Scanning minute by minute is cheap enough at this granularity and
 * cannot disagree with the matcher, which a second implementation would.
 */
export function nextRun(expression: string | null | undefined, from: Date = new Date()): Date | null {
  const expr = (expression ?? '').trim();
  if (!expr || !isValidCron(expr)) return null;

  const at = new Date(from.getTime());
  at.setUTCSeconds(0, 0);
  at.setUTCMinutes(at.getUTCMinutes() + 1);

  const MINUTES_IN_A_YEAR = 366 * 24 * 60;
  for (let i = 0; i < MINUTES_IN_A_YEAR; i++) {
    if (cronMatches(expr, at)) return at;
    at.setUTCMinutes(at.getUTCMinutes() + 1);
  }
  return null;
}

/** "in 3h 12m" — how long until the schedule next fires. */
export function untilNextRun(expression: string | null | undefined, from: Date = new Date()): string | null {
  const next = nextRun(expression, from);
  if (!next) return null;
  const mins = Math.round((next.getTime() - from.getTime()) / 60_000);
  if (mins < 1) return 'in under a minute';
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h ${mins % 60}m`;
  return `in ${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : lo)));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
