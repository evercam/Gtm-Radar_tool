import Link from 'next/link';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { RECORD_COLUMNS, type RecordColumn } from '@/components/records/columns';

/**
 * Shared table controls — used by /records and /accounts.
 *
 * Moved out of components/records once the accounts table wanted the same
 * dropdowns and the same removable chips. ColumnPicker is still record-specific
 * (it reads RECORD_COLUMNS); FilterDropdown, OwnerFilter, DateWindowPicker and
 * ActiveFilters are not, and a second copy of them would be a second set of
 * behaviours to keep in step.
 *
 * The column chooser, and the chips showing what is narrowing the list.
 *
 * A date window belongs here too and is deliberately absent. It was built, and it
 * returned "No records match these filters" against a table holding 111,242 of
 * them: `is(apollo_exported_at, null)` + `gte(created_at, …)` + an exact count
 * takes over eight seconds and Postgres cancels it. The rows come back in 754ms —
 * it is only the COUNT that cannot be had. Shipping the control would have meant
 * shipping a filter that reports an empty book, so it comes back when the count
 * can be made optional, not before.
 *
 * WHY THESE ARE LINKS AND NOT A CLIENT COMPONENT
 *
 * Every filter on this page is already a URL parameter resolved on the server.
 * Putting the column choice in React state instead would mean shipping the table
 * to the browser, losing the streamed server render, and giving two people
 * looking at "the same table" different tables. In the URL it is shareable,
 * bookmarkable, survives a reload, and costs no JavaScript at all.
 *
 * `<details>` gives the dropdown. It opens and closes with no script, keyboard
 * works because summary is focusable, and it degrades to an open list if CSS
 * fails. The alternative was a Radix popover and a 'use client' boundary to
 * toggle a menu that contains nothing but links.
 */

function Dropdown({
  label,
  summary,
  children,
  align = 'left',
}: {
  label: string;
  /** The current selection, shown on the closed control — a filter you cannot see is a filter you forget. */
  summary: string;
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <details className="group relative">
      <summary
        className={cn(
          'border-border-base bg-surface text-body hover:border-border-strong hover:text-foreground',
          'focus-visible:outline-brand flex cursor-pointer list-none items-center gap-1.5 rounded-lg border px-2.5 py-1.5',
          'text-[11px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2'
        )}
      >
        <span className="text-muted">{label}</span>
        <span className="text-foreground">{summary}</span>
        <span className="text-subtle text-[8px] transition-transform group-open:rotate-180">▼</span>
      </summary>
      <div
        className={cn(
          'border-border-base bg-surface absolute z-20 mt-1 min-w-[200px] rounded-lg border p-1.5',
          'shadow-[var(--shadow-overlay)]',
          align === 'right' ? 'right-0' : 'left-0'
        )}
      >
        {children}
      </div>
    </details>
  );
}

function Item({
  href,
  active,
  children,
  hint,
  title,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
  /** Short, shown on the right — a count or a qualifier. */
  hint?: string;
  /** Long, on hover. The sort options need a sentence, not a word. */
  title?: string;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      scroll={false}
      title={title}
      className={cn(
        'flex items-center justify-between gap-3 rounded px-2 py-1.5 text-[11px]',
        active ? 'bg-brand/10 text-brand font-semibold' : 'text-body hover:bg-surface-raised hover:text-foreground'
      )}
    >
      <span>{children}</span>
      {hint ? <span className="text-subtle text-[10px]">{hint}</span> : null}
    </Link>
  );
}

/**
 * Column chooser.
 *
 * Each row toggles one column by rewriting `?cols=`. Locked columns are shown so
 * the reader can see the full shape of the table, but they are not links —
 * offering a control that refuses to do anything is worse than not offering it.
 */
export function ColumnPicker({
  chosen,
  hrefForCols,
}: {
  chosen: RecordColumn[];
  hrefForCols: (keys: string[]) => string;
}) {
  const on = new Set(chosen.map((c) => c.key));
  const optional = RECORD_COLUMNS.filter((c) => !c.locked);
  const shownOptional = optional.filter((c) => on.has(c.key)).length;

  return (
    <Dropdown label="Columns" summary={`${chosen.length}/${RECORD_COLUMNS.length}`} align="right">
      <div className="max-h-80 overflow-y-auto">
        {RECORD_COLUMNS.map((c) => {
          if (c.locked) {
            return (
              <div key={c.key} className="flex items-center justify-between gap-3 px-2 py-1.5 text-[11px]">
                <span className="text-muted">{c.label}</span>
                <span className="text-subtle text-[10px]">always</span>
              </div>
            );
          }
          const isOn = on.has(c.key);
          const next = isOn ? optional.filter((o) => o.key !== c.key && on.has(o.key)) : [...optional.filter((o) => on.has(o.key)), c];
          return (
            <Item key={c.key} href={hrefForCols(next.map((n) => n.key))} active={isOn}>
              <span className="inline-flex items-center gap-2">
                <span
                  className={cn(
                    'inline-block h-3 w-3 shrink-0 rounded-sm border text-center text-[9px] leading-3',
                    isOn ? 'border-brand bg-brand text-brand-contrast' : 'border-border-strong'
                  )}
                >
                  {isOn ? '✓' : ''}
                </span>
                {c.label}
              </span>
            </Item>
          );
        })}
      </div>
      <div className="border-border-base mt-1.5 flex items-center justify-between gap-2 border-t pt-1.5">
        <Link
          href={hrefForCols(optional.map((c) => c.key))}
          prefetch={false}
          scroll={false}
          className="text-brand px-2 text-[10px] underline"
        >
          All
        </Link>
        <span className="text-subtle text-[10px]">{shownOptional} optional shown</span>
        <Link href={hrefForCols([])} prefetch={false} scroll={false} className="text-brand px-2 text-[10px] underline">
          None
        </Link>
      </div>
    </Dropdown>
  );
}

/**
 * The arrival window.
 *
 * Windows by `created_at` — when the lead reached this table — not by any date the
 * source claims about the project. Several of those are null, and a control that
 * silently drops every undated record lies about the size of the book.
 *
 * WHY THE NARROW WINDOW ALSO SETS THE SORT
 *
 * Measured against 111k rows, three times each:
 *
 *   7 days,  sort=priority    8.7s / 8.9s / 8.9s   timeout, every time
 *   7 days,  sort=newest      954ms                fine
 *   30 days, sort=priority    300ms                fine
 *   90 days, sort=priority    214ms                fine
 *
 * A narrow window with an unrelated sort order forces Postgres to find every
 * matching row and then sort it; aligning the sort with the filter walks one
 * access path. So the narrow window carries `sort=newest` in its own link and the
 * item says so — the sort chips above the table will visibly change, which is the
 * difference between a documented pairing and a silent override.
 *
 * A reader who then picks a different sort on a 7-day window gets a real timeout,
 * and since getRecords now reports failure instead of an empty list, the page says
 * so and tells them to narrow it. That is an acceptable dead end; a filter that
 * quietly claims the book is empty was not.
 */
export const DATE_WINDOWS = [
  { key: '7', label: 'Last 7 days', days: 7, forceSort: 'newest' as const },
  { key: '30', label: 'Last 30 days', days: 30, forceSort: undefined },
  { key: '90', label: 'Last 90 days', days: 90, forceSort: undefined },
] as const;

export function DateWindowPicker({
  current,
  hrefForWindow,
}: {
  current: string | undefined;
  hrefForWindow: (key: string | undefined, forceSort?: string) => string;
}) {
  const active = DATE_WINDOWS.find((w) => w.key === current);
  return (
    <Dropdown label="Arrived" summary={active ? active.label : 'All time'} align="right">
      <Item href={hrefForWindow(undefined)} active={!active}>
        All time
      </Item>
      {DATE_WINDOWS.map((w) => (
        <Item
          key={w.key}
          href={hrefForWindow(w.key, w.forceSort)}
          active={active?.key === w.key}
          hint={w.forceSort ? `by ${w.forceSort}` : undefined}
        >
          {w.label}
        </Item>
      ))}
      <p className="text-subtle border-border-base mt-1.5 border-t px-2 pt-1.5 text-[10px]">
        A window trades the exact count for speed — the header shows the page range instead.
      </p>
    </Dropdown>
  );
}

/**
 * What is currently narrowing the list, as removable chips.
 *
 * Ads Manager's filter row does this and it is the part worth copying most: with
 * thirteen possible filters, the state that matters is which ones are ON. Reading
 * that off a row of dropdowns means opening all thirteen.
 */
export function ActiveFilters({
  filters,
  hrefWithout,
}: {
  filters: { key: string; label: string; value: string }[];
  hrefWithout: (key: string) => string;
}) {
  if (filters.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-subtle text-[10px] font-semibold uppercase tracking-widest">Filtered by</span>
      {filters.map((f) => (
        <Link
          key={f.key}
          href={hrefWithout(f.key)}
          prefetch={false}
          scroll={false}
          title={`Remove the ${f.label} filter`}
          className="group/chip"
        >
          <Badge tone="brand">
            {f.label}: {f.value}
            <span className="ml-1 opacity-60 group-hover/chip:opacity-100">✕</span>
          </Badge>
        </Link>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* FilterDropdown                                                             */
/* -------------------------------------------------------------------------- */

export interface FilterOption {
  value: string;
  label: string;
  /** Short qualifier shown on the right of the row. */
  hint?: string;
  /** Sentence-length explanation, on hover. */
  title?: string;
}

/**
 * One filter, as a dropdown that says what it is currently set to.
 *
 * WHAT THIS REPLACES
 *
 * Every filter was a row of chips, all of them visible at once: 34 sources plus
 * BU, type, route, stage, priority, owner, status and sort came to roughly seventy
 * chips across five wrapped rows, and the source row alone took four of them. The
 * table started below the fold on a laptop, and finding "is anything filtering
 * this list" meant reading seventy pills for the one with a tinted background.
 *
 * A closed dropdown is one control that states its own value, so eight of them fit
 * on one line and the ninth thing on that line is the table. What is actually ON
 * is answered by ActiveFilters below, not by scanning.
 *
 * Still links, still no JavaScript — same reasoning as the column picker. `single`
 * is the whole model here: every one of these filters is a single value in the URL,
 * so choosing an option replaces rather than accumulates, and choosing the active
 * one again clears it.
 */
export function FilterDropdown({
  label,
  current,
  options,
  hrefFor,
  allLabel = 'All',
  align = 'left',
}: {
  label: string;
  current: string | undefined;
  options: FilterOption[];
  /** undefined clears the filter. */
  hrefFor: (value: string | undefined) => string;
  allLabel?: string;
  align?: 'left' | 'right';
}) {
  const active = options.find((o) => o.value === current);
  return (
    <Dropdown label={label} summary={active ? active.label : allLabel} align={align}>
      {/*
        Scrolls because of `source`, which has 34 options. Capping the panel rather
        than the list keeps every source reachable — a "top 10 and a search box"
        would hide exactly the long-tail source somebody is hunting for.
      */}
      <div className="max-h-72 overflow-y-auto">
        <Item href={hrefFor(undefined)} active={!active}>
          {allLabel}
        </Item>
        {options.map((o) => (
          <Item
            key={o.value}
            /* Clicking the active option clears it — the chips below can also do
               this, but the control that set a filter should be able to unset it. */
            href={hrefFor(o.value === current ? undefined : o.value)}
            active={o.value === current}
            hint={o.hint}
            title={o.title}
          >
            {o.label}
          </Item>
        ))}
      </div>
    </Dropdown>
  );
}

/**
 * Owner, which is three states across two parameters.
 *
 * "Mine" is mine=1. "Everyone" is mine=0. "Unassigned" is mine=0 AND owner=none.
 * Every other filter on this page is one value in one key, so this cannot be a
 * FilterDropdown without teaching that control about pairs for the sake of one
 * caller.
 *
 * "Everyone" is hidden from someone who cannot see everyone. Offering it and then
 * refusing is worse than not offering it — the same reason the column picker shows
 * locked columns as text rather than as dead links.
 */
export function OwnerFilter({
  mine,
  unassigned,
  canSeeAll,
  hrefFor,
}: {
  mine: string;
  unassigned: boolean;
  canSeeAll: boolean;
  hrefFor: (patch: Record<string, string | undefined>) => string;
}) {
  const summary = unassigned ? 'Unassigned' : mine === '1' ? 'Mine' : 'Everyone';
  return (
    <Dropdown label="Owner" summary={summary}>
      <Item href={hrefFor({ mine: '1', owner: undefined })} active={mine === '1' && !unassigned}>
        Mine
      </Item>
      {canSeeAll ? (
        <Item href={hrefFor({ mine: '0', owner: undefined })} active={mine === '0' && !unassigned}>
          Everyone
        </Item>
      ) : null}
      <Item href={hrefFor({ mine: '0', owner: 'none' })} active={unassigned} hint="nobody assigned">
        Unassigned
      </Item>
    </Dropdown>
  );
}
