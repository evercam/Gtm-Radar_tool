/**
 * Turning a tool's result into something worth reading.
 *
 * Every tool used to answer with `JSON.stringify(result, null, 2)`. That is
 * complete and it is not presentable: an assistant asked for "P1 jobs in the UK"
 * received four hundred lines of quoted keys, and whatever it then showed the
 * person was a paraphrase it had to reconstruct. Pretty-printed JSON also costs
 * three to four times the tokens of the same rows as a table, which is context
 * spent on punctuation.
 *
 * So results are rendered as markdown here, and markdown is the deliberate
 * choice rather than a default: it is already a clean list on screen, it converts
 * to a table in a spreadsheet by pasting, and it is the format an assistant can
 * lift into HTML or a document without inventing structure. The exact values
 * still travel alongside as `structuredContent`, so nothing is lost for a caller
 * that wants to compute rather than read.
 *
 * SHAPE-DRIVEN, NOT TOOL-DRIVEN. There is no per-tool renderer and that is the
 * important design decision. A registry keyed by tool name would drift the first
 * time a tool gained a field — the renderer would keep producing yesterday's
 * columns and nobody would notice, which is exactly the failure this codebase
 * keeps having with parallel definitions. Instead the rules key off the SHAPE of
 * the value and the NAME of the field, both of which are already consistent
 * across tools: `ref` and `name` identify, `*At` is a timestamp, `value` pairs
 * with `currency`, `durationMs` is a duration. A tool that adds a field gets it
 * rendered for free, formatted correctly if its name follows the conventions and
 * plainly if it does not.
 */

/* -------------------------------------------------------------------------- */
/* Value formatting                                                           */
/* -------------------------------------------------------------------------- */

/** Nothing to show. An em dash rather than "null", which reads as a value. */
const EMPTY = '—';

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
  AUD: 'A$',
  CAD: 'C$',
  INR: '₹',
};

const number = (n: number) => n.toLocaleString('en-GB');

/**
 * Money, with the symbol attached and no decimals.
 *
 * Pence on a £40m construction project is noise, and the underlying figures are
 * estimates from a procurement notice rather than accounts. An unknown currency
 * code is printed after the amount rather than dropped — losing it would turn
 * three different currencies into one meaningless column.
 */
function money(amount: number, currency?: unknown): string {
  const rounded = Math.round(amount);
  const code = typeof currency === 'string' ? currency.toUpperCase() : null;
  if (!code) return number(rounded);
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol}${number(rounded)}` : `${number(rounded)} ${code}`;
}

/**
 * A timestamp, at the precision that is actually meaningful.
 *
 * A date for things that happen once a day or less — an export, an ingest — and
 * date plus time for a run, where two runs on the same day is the normal case and
 * a bare date would make them indistinguishable.
 */
function timestamp(value: string, withTime: boolean): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const date = d.toISOString().slice(0, 10);
  return withTime ? `${date} ${d.toISOString().slice(11, 16)}` : date;
}

/** Milliseconds as something a person reads without counting zeroes. */
function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Field names whose timestamp is worth showing to the minute. */
const TIME_PRECISE = /^(startedAt|finishedAt|at)$/;

/** Field names that are timestamps at all. */
const IS_TIMESTAMP = /(^|[a-z])At$|^lastIngested$|^last[A-Z]/;

/**
 * Scope arrays, where EMPTY MEANS EVERYTHING.
 *
 * This is the one place a blank cell would state the opposite of the truth. An
 * assignee with no `bu` restriction can receive leads from every business unit,
 * so rendering `[]` as a dash would read as "receives nothing" — and somebody
 * would go looking for why that person is being skipped.
 */
const UNRESTRICTED_WHEN_EMPTY = new Set(['bu', 'verticals', 'regions']);

/** Cell text for one field of one row. */
function cell(key: string, value: unknown, row: Record<string, unknown>): string {
  if (value === null || value === undefined || value === '') {
    return UNRESTRICTED_WHEN_EMPTY.has(key) ? 'any' : EMPTY;
  }

  if (typeof value === 'boolean') return value ? 'yes' : EMPTY;

  if (Array.isArray(value)) {
    if (value.length === 0) return UNRESTRICTED_WHEN_EMPTY.has(key) ? 'any' : EMPTY;
    // Objects inside a cell are unreadable; report the count and let the caller
    // reach for structuredContent or the per-record tool if they need them.
    if (value.some((v) => v !== null && typeof v === 'object')) return `${value.length}`;
    return value.join(', ');
  }

  if (typeof value === 'number') {
    if (key === 'durationMs') return duration(value);
    if (key === 'avgCompleteness') return `${Math.round(value)}%`;
    if (/^(value|totalValue|estimatedValue)$/.test(key)) return money(value, row.currency);
    return number(value);
  }

  if (typeof value === 'string') {
    if (IS_TIMESTAMP.test(key)) return timestamp(value, TIME_PRECISE.test(key));
    return value;
  }

  if (typeof value === 'object') return EMPTY;
  return String(value);
}

/**
 * Makes a value safe to put in a markdown table cell.
 *
 * Pipes and newlines both terminate a cell, so an unescaped one silently shifts
 * every remaining column left — a corrupted row that still looks like a row. The
 * length cap is for the same reason at a different scale: a 900-character error
 * message in one cell makes the whole table unreadable.
 */
function cellSafe(text: string, limit = 80): string {
  const flat = text.replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/* -------------------------------------------------------------------------- */
/* Column ordering                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which columns come first, when a row has them.
 *
 * Identity before attributes before metadata, because a table is scanned down its
 * first column: the thing that says WHICH row this is has to be there. Anything
 * unlisted keeps its original order after these, so a new field appears rather
 * than being dropped.
 */
const COLUMN_ORDER = [
  'ref',
  'name',
  'key',
  // Who the record is about outranks where it came from: a person scanning for
  // "the Kier job" looks for the company, not the feed that delivered it.
  'company',
  'party',
  'role',
  'email',
  'source',
  'sourceKey',
  'slug',
  'status',
  'phase',
  'band',
  'score',
  'value',
  'buildingType',
  'category',
  'vertical',
  'bu',
  'verticals',
  'regions',
  'location',
  'total',
  'records',
  'fetched',
  'inserted',
  'updated',
  'duplicates',
  'requested',
  'created',
  'existing',
  'received',
  'readyToSend',
  'assigned',
  'exported',
  'failed',
  'dailyQuota',
  'active',
  'enabled',
  'reachable',
  'contacts',
  'startedAt',
  'exportedAt',
  'lastIngested',
  'durationMs',
  'error',
];

/**
 * Columns that repeat a neighbour and earn no space of their own.
 *
 * `currency` is consumed by the money formatter next to the amount, and `phaseRaw`
 * is the unnormalised source wording that `phase` already expresses — 117 raw
 * values map to 11, so showing both makes a wide table wider to say the same
 * thing. Both remain in `structuredContent` for anyone who needs them.
 */
const REDUNDANT_COLUMNS = new Set(['currency', 'phaseRaw', 'id', 'accountKey', 'params']);

function orderColumns(keys: string[]): string[] {
  const visible = keys.filter((k) => !REDUNDANT_COLUMNS.has(k));
  return visible.sort((a, b) => {
    const ia = COLUMN_ORDER.indexOf(a);
    const ib = COLUMN_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return keys.indexOf(a) - keys.indexOf(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

/**
 * Acronyms that a generic capitaliser gets wrong.
 *
 * Small list, and it earns its place: "Bu" as a column heading reads as a typo,
 * and the point of this module is output somebody is happy to look at.
 */
const ACRONYMS: Record<string, string> = { bu: 'BU', id: 'ID', url: 'URL', icp: 'ICP', kpi: 'KPI' };

/** `readyToSend` -> `Ready to send`. Labels are derived, never hand-maintained. */
function label(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced
    .split(' ')
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (ACRONYMS[lower]) return ACRONYMS[lower];
      // Only the first word is capitalised — "Ready to send", not "Ready To Send",
      // which is a heading rather than a title.
      return i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(' ');
}

/** Right-aligned columns, so digits line up and can be compared down the column. */
const NUMERIC = /^(count|total|records|score|value|totalValue|fetched|inserted|updated|duplicates|failed|requested|created|existing|received|readyToSend|assigned|exported|contacts|dailyQuota|projectCount|avgCompleteness|durationMs|waitingOnContact|blockedUnverified|doNotContact|maxRecordsPerRun|relatedEntities|portfolioProjects)$/;

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function table(rows: Record<string, unknown>[]): string {
  // Union of keys across rows, not just the first — a later row may carry a field
  // an earlier one left off, and taking only the first row's keys would drop it.
  const keys: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!keys.includes(k)) keys.push(k);

  const columns = orderColumns(keys);
  if (columns.length === 0) return '';

  const header = `| ${columns.map(label).join(' | ')} |`;
  const rule = `| ${columns.map((c) => (NUMERIC.test(c) ? '--:' : '---')).join(' | ')} |`;
  const body = rows.map(
    (row) => `| ${columns.map((c) => cellSafe(cell(c, row[c], row), c === 'error' ? 100 : 80)).join(' | ')} |`
  );

  return [header, rule, ...body].join('\n');
}

/**
 * A short `key: value · key: value` line for the scalars around a table.
 *
 * FALSE AND NULL ARE OMITTED here, unlike in a table. A table needs the cell to
 * keep its columns aligned, but a summary line has no alignment to preserve and
 * "Truncated: —" is pure noise — the flag is interesting only when it is true.
 * Dropping it means the line says what happened rather than everything that
 * didn't.
 */
function summaryLine(entries: [string, unknown][]): string {
  return entries
    .filter(([, v]) => v !== false && v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `**${label(k)}:** ${cellSafe(cell(k, v, {}), 120)}`)
    .join(' · ');
}

/** A field-per-line block, for a single record rather than a list. */
function definitionList(entries: [string, unknown][]): string {
  return entries.map(([k, v]) => `- **${label(k)}:** ${cellSafe(cell(k, v, Object.fromEntries(entries)), 200)}`).join('\n');
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A string worth its own section rather than a cell — the rendered call brief. */
const isProse = (v: unknown): v is string => typeof v === 'string' && (v.includes('\n') || v.length > 160);

/**
 * Renders a tool result as markdown.
 *
 * Splits the top level by shape and emits each part the way that shape reads
 * best: scalars as a summary line, a list of records as a table, prose as its own
 * section, nested objects as an indented block. Everything is driven off the
 * value, so this handles a tool it has never seen.
 */
export function presentResult(result: unknown): string {
  if (result === null || result === undefined) return '_No result._';
  if (typeof result !== 'object') return String(result);
  if (Array.isArray(result)) {
    if (result.length === 0) return '_Nothing to show._';
    return result.every(isPlainObject) ? table(result as Record<string, unknown>[]) : result.map((r) => `- ${cellSafe(String(r), 200)}`).join('\n');
  }

  const entries = Object.entries(result as Record<string, unknown>);

  const scalars: [string, unknown][] = [];
  const tables: [string, Record<string, unknown>[]][] = [];
  const empties: string[] = [];
  const prose: [string, string][] = [];
  const nested: [string, Record<string, unknown>][] = [];

  for (const [key, value] of entries) {
    if (Array.isArray(value) && value.every(isPlainObject)) {
      if (value.length === 0) empties.push(key);
      else tables.push([key, value as Record<string, unknown>[]]);
    } else if (isProse(value)) prose.push([key, value]);
    else if (isPlainObject(value)) nested.push([key, value]);
    else scalars.push([key, value]);
  }

  const parts: string[] = [];

  /*
    A single record — no list at all — reads as a block of fields rather than a
    one-line summary that runs off the screen. get_project and get_account arrive
    here.
  */
  const isSingleRecord = tables.length === 0 && empties.length === 0 && scalars.length > 4;

  if (scalars.length > 0) parts.push(isSingleRecord ? definitionList(scalars) : summaryLine(scalars));

  for (const [key, rows] of tables) {
    // A heading only when there is more than one list to tell apart — a lone
    // table under a summary line needs no label.
    if (tables.length > 1 || nested.length > 0 || prose.length > 0) parts.push(`**${label(key)}**`);
    parts.push(table(rows));
  }

  /*
    An empty list says so in words. An empty table — a header with no rows — looks
    like a rendering failure, and "0 results" is a real answer that deserves to be
    stated rather than implied by absence.
  */
  for (const key of empties) parts.push(`_No ${label(key).toLowerCase()} matched._`);

  for (const [key, value] of nested) {
    parts.push(`**${label(key)}**`);
    parts.push(definitionList(Object.entries(value)));
  }

  for (const [key, value] of prose) {
    parts.push(`**${label(key)}**`);
    // Verbatim, in a quote block: the call brief is written to be read by a rep
    // and reflowing it would spoil the formatting it already has.
    parts.push(
      value
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    );
  }

  return parts.filter(Boolean).join('\n\n');
}

/**
 * Renders a tool FAILURE.
 *
 * Kept in the same shape as a result so a caller does not have to branch on
 * whether it is reading an answer or an explanation. The code is included because
 * it is the stable, greppable part — `assignee_ambiguous` is what somebody
 * searches for, not the sentence around it.
 */
export function presentError(payload: { code: string; message: string; details?: unknown }): string {
  const parts = [`**${label(payload.code)}** — ${payload.message}`];
  if (payload.details !== undefined && payload.details !== null) {
    const rendered = presentResult(payload.details);
    if (rendered && rendered !== '_No result._') parts.push(rendered);
  }
  return parts.join('\n\n');
}
