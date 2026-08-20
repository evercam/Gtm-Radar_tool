import Link from 'next/link';
import type { ReactNode } from 'react';
import type { RecordRow } from '@/lib/queries';
import { arrivalFor } from '@/lib/arrival';
import {
  ARRIVAL_COLORS,
  ARRIVAL_LABELS,
  BAND_COLORS,
  BAND_LABELS,
  BU_SHORT,
  CONTACT_STATUS_COLORS,
  ROUTE_TEXT,
  titleize,
} from '@/lib/semantics';
import { STATUS_COLORS, STATUS_LABELS, type LeadStatus } from '@/lib/lifecycle';
import { Badge } from '@/components/ui';

/**
 * The lead table's columns, as data.
 *
 * They were fifteen hand-written <Th> plus fifteen hand-written <Td> in the page,
 * which is fine right up to the moment somebody wants to choose between them. A
 * column picker cannot reach into JSX; it needs a list it can filter. So each
 * column is a key, a label, an alignment and a render function, and the table
 * becomes a loop.
 *
 * Cell rendering is moved here VERBATIM, comments included, because every one of
 * those decisions was made against a real row and none of them should be
 * relitigated by a refactor whose only job is to make the set selectable.
 */

export interface RecordColumn {
  key: string;
  /** Header text. Short: fifteen of these share one row. */
  label: string;
  align?: 'left' | 'right';
  /**
   * Columns the table refuses to hide.
   *
   * A row with no name is not a row anybody can act on, and priority is the
   * reason the list is sorted the way it is. Everything else is the reader's
   * choice — that is the whole point of the picker.
   */
  locked?: boolean;
  render: (r: RecordRow, ctx: RecordCellContext) => ReactNode;
}

export interface RecordCellContext {
  /** Builds the drawer link for a row, preserving the current filters. */
  hrefFor: (id: string) => string;
}

const dash = <span className="text-subtle text-[10px]">—</span>;

function money(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${n}`;
}

function exportDate(v: string): string {
  const d = new Date(v);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function slaTone(dueAt: string, breached: boolean | null): 'danger' | 'warning' | 'success' {
  if (breached) return 'danger';
  return new Date(dueAt).getTime() - Date.now() < 24 * 3600_000 ? 'warning' : 'success';
}

function slaLabel(dueAt: string, breached: boolean | null): string {
  const ms = new Date(dueAt).getTime() - Date.now();
  if (breached || ms < 0) return 'past SLA';
  const h = Math.round(ms / 3600_000);
  return h < 24 ? `${h}h left` : `${Math.round(h / 24)}d left`;
}

/**
 * How early we are arriving, next to the priority that decides whether anyone
 * looks. A high score on a project that is already built is not a lead, and that
 * was previously only discoverable by opening the drawer and reading the phase.
 * The tooltip carries the basis, because a verdict inferred from the phase alone
 * must not read like one measured against a real construction start date.
 */
function ArrivalBadge({ record }: { record: RecordRow }) {
  const a = arrivalFor(record);
  return (
    <Badge className={ARRIVAL_COLORS[a.verdict]} title={a.basis}>
      {ARRIVAL_LABELS[a.verdict]}
    </Badge>
  );
}

export const RECORD_COLUMNS: RecordColumn[] = [
  {
    key: 'pri',
    label: 'Pri',
    locked: true,
    render: (r) =>
      r.priority_band ? (
        <Badge
          className={BAND_COLORS[r.priority_band]}
          title={r.priority_reasons?.join(' · ') || BAND_LABELS[r.priority_band]}
        >
          {r.priority_band} · {r.priority_score}
        </Badge>
      ) : (
        <span className="text-subtle text-[10px]">unscored</span>
      ),
  },
  { key: 'arrival', label: 'How early', render: (r) => <ArrivalBadge record={r} /> },
  {
    key: 'name',
    label: 'Name',
    locked: true,
    /*
      Every record opens its own detail drawer. This used to link only when
      `account_key` was set — populated by Claude enrichment alone — so 16,332 of
      16,515 project records were plain text with nothing to click. The account
      page is still reachable, from inside the drawer, where it belongs: it
      describes the company, not this record.
    */
    render: (r, { hrefFor }) => (
      <Link href={hrefFor(r.id)} prefetch={false} scroll={false} className="hover:underline">
        {r.canonical_name}
      </Link>
    ),
  },
  { key: 'ref', label: 'Ref', render: (r) => <span className="font-mono text-[10px]">{r.ref_code ?? '—'}</span> },
  { key: 'source', label: 'Source', render: (r) => r.source_key },
  { key: 'type', label: 'Type', render: (r) => r.record_type ?? '—' },
  { key: 'bu', label: 'BU', render: (r) => (r.bu ? (BU_SHORT[r.bu] ?? r.bu) : '—') },
  { key: 'vertical', label: 'Vertical', render: (r) => (r.vertical ? titleize(r.vertical) : '—') },
  { key: 'country', label: 'Country', render: (r) => r.country ?? '—' },
  {
    key: 'value',
    label: 'Value / MW',
    align: 'right',
    render: (r) =>
      r.estimated_value != null
        ? money(r.estimated_value)
        : r.capacity_mw != null
          ? `${Math.round(r.capacity_mw).toLocaleString()} MW`
          : '—',
  },
  {
    key: 'completeness',
    label: 'Compl.',
    align: 'right',
    render: (r) => (r.population_percentage != null ? `${Math.round(r.population_percentage)}%` : '—'),
  },
  {
    key: 'status',
    label: 'Status',
    /*
      Export outranks status. An archived lead still reads ASSIGNED in the status
      column, so showing the status here would put a lead that has left the
      building in the same cell state as one a seller is expected to work. The
      date comes with the badge because "when was this handed over" is the
      question anyone looking at an archived row is actually asking — and
      `sort=exported` orders by the same value they are reading.
    */
    render: (r) =>
      r.apollo_exported_at ? (
        <Badge
          tone="success"
          title={`Archived — sent to Apollo on ${new Date(r.apollo_exported_at).toLocaleString('en-GB')}${
            r.apollo_export_status ? ` · ${r.apollo_export_status}` : ''
          }${r.status ? ` · lifecycle ${STATUS_LABELS[r.status as LeadStatus] ?? r.status}` : ''}`}
        >
          exported {exportDate(r.apollo_exported_at)}
        </Badge>
      ) : r.apollo_export_status === 'failed' ? (
        // Not archived: a failed send stays in the queue, and the row must not
        // look handed over.
        <Badge tone="danger" title="The send to Apollo failed — still queued for the next run">
          export failed
        </Badge>
      ) : r.status ? (
        <Badge className={STATUS_COLORS[r.status as LeadStatus] ?? ''}>
          {STATUS_LABELS[r.status as LeadStatus] ?? r.status}
        </Badge>
      ) : (
        dash
      ),
  },
  {
    key: 'lane',
    label: 'Lane',
    render: (r) =>
      r.route ? (
        <span className={ROUTE_TEXT[r.route] ?? 'text-muted'}>
          {r.route}
          <span className="text-subtle">/{r.stage}</span>
        </span>
      ) : (
        <span className="text-subtle">—</span>
      ),
  },
  {
    key: 'contact',
    label: 'Contact',
    render: (r) => (
      <Badge className={CONTACT_STATUS_COLORS[r.contact_status ?? 'needs_enrichment']}>
        {r.contact_status === 'has_contact' ? 'contact' : 'enrich'}
      </Badge>
    ),
  },
  {
    key: 'sla',
    label: 'SLA',
    render: (r) =>
      r.sla_due_at ? (
        <Badge tone={slaTone(r.sla_due_at, r.sla_breached)}>{slaLabel(r.sla_due_at, r.sla_breached)}</Badge>
      ) : (
        dash
      ),
  },
];

/** Shown when the reader has expressed no preference — the set the table always had. */
export const DEFAULT_COLUMN_KEYS = RECORD_COLUMNS.map((c) => c.key);

/**
 * Resolve `?cols=` to a column list.
 *
 * Unknown keys are dropped rather than rejected, and locked columns are put back
 * whatever the URL says. Both are the same rule the rest of this page follows: a
 * stale bookmark should show a slightly wrong table, never an error and never a
 * table with no name column.
 *
 * Order follows RECORD_COLUMNS, not the URL. Letting the URL reorder would mean
 * two readers with the same columns seeing different tables, and there is no
 * control that asks for a reorder.
 */
export function resolveColumns(param: string | undefined): RecordColumn[] {
  if (!param) return RECORD_COLUMNS;
  const asked = new Set(param.split(',').filter(Boolean));
  const chosen = RECORD_COLUMNS.filter((c) => c.locked || asked.has(c.key));
  return chosen.length ? chosen : RECORD_COLUMNS;
}
