import Link from 'next/link';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { RECORD_COLUMNS, type RecordColumn } from './columns';

/**
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
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      scroll={false}
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
