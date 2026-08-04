import Link from 'next/link';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { getRecords, getRecordDetail, type RecordRow, type RecordSort } from '@/lib/queries';
import { arrivalFor } from '@/lib/arrival';
import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { SOURCE_CATALOG } from '@/lib/sourceCatalog';
import {
  BAND_COLORS,
  ARRIVAL_COLORS,
  ARRIVAL_LABELS,
  BAND_LABELS,
  BU_SHORT,
  BUSINESS_UNITS,
  CONTACT_STATUS_COLORS,
  RECORD_TYPES,
  ROUTES,
  ROUTE_TEXT,
  STAGES,
  titleize,
} from '@/lib/semantics';
import { PRIORITY_BANDS } from '@/lib/priority';
import { LEAD_STATUSES, STATUS_COLORS, STATUS_LABELS, type LeadStatus } from '@/lib/lifecycle';
import { Badge, Chip, EmptyState, Table, TableShell, TBody, THead, Th, Td } from '@/components/ui';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import RecordDrawer from '@/components/RecordDrawer';
import RecordDetail from '@/components/RecordDetail';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

function money(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

/**
 * Compact enough for a table cell: "3 Aug" this year, "3 Aug 25" otherwise.
 *
 * The year is dropped only when it is the current one, so a handover from last
 * season can never be misread as a recent one.
 */
function exportDate(v: string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: '2-digit' }),
  });
}

/** How urgent the deadline is — breached, due soon, or comfortable. */
function slaTone(dueAt: string, breached: boolean | null): 'danger' | 'warning' | 'success' {
  if (breached) return 'danger';
  const hoursLeft = (new Date(dueAt).getTime() - Date.now()) / 3_600_000;
  if (hoursLeft < 0) return 'danger';
  return hoursLeft < 4 ? 'warning' : 'success';
}

function slaLabel(dueAt: string, breached: boolean | null): string {
  const hoursLeft = (new Date(dueAt).getTime() - Date.now()) / 3_600_000;
  if (breached || hoursLeft < 0) return 'breached';
  if (hoursLeft < 1) return `${Math.round(hoursLeft * 60)}m left`;
  if (hoursLeft < 48) return `${Math.round(hoursLeft)}h left`;
  return `${Math.round(hoursLeft / 24)}d left`;
}

type SP = Record<string, string | undefined>;

function qs(base: SP, patch: SP): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...patch })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `/records?${s}` : '/records';
}

/**
 * How early we are arriving, as a chip.
 *
 * The tooltip carries the basis. A trailing "?" marks a verdict with no dates
 * behind it — inferred from the phase alone — so the two are distinguishable at
 * a glance rather than only on hover.
 */
function ArrivalBadge({ record }: { record: RecordRow }) {
  const a = arrivalFor(record);
  return (
    <Badge className={ARRIVAL_COLORS[a.verdict]} title={a.summary}>
      {ARRIVAL_LABELS[a.verdict]}
      {a.dated ? '' : ' ?'}
    </Badge>
  );
}

export default async function RecordsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser('/records');

  if (!isSupabaseServerConfigured()) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-16">
        <SupabaseNotConfigured />
      </div>
    );
  }

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const source = sp.source,
    bu = sp.bu,
    vertical = sp.vertical,
    recordType = sp.type,
    contactStatus = sp.contact,
    search = sp.q;
  const route = sp.route,
    stage = sp.stage,
    band = sp.band,
    status = sp.status,
    completenessTier = sp.tier,
    ownerGroup = sp.owner_group;
  // Sellers see their own book by default; managers and admins see everything
  // and opt into a narrower view. `mine=0` lets a seller look at the wider
  // pool their scope covers without pretending they own it.
  const canSeeAll = can(user.role, 'leads.view.all');
  const mine = sp.mine ?? (canSeeAll ? '0' : '1');
  const ownerId = mine === '1' ? user.id : undefined;
  const unassigned = sp.owner === 'none';
  const sort = (['priority', 'newest', 'value', 'exported'].includes(sp.sort ?? '')
    ? sp.sort
    : 'priority') as RecordSort;
  // Exported leads are archived out of the working list. `archived=1` brings
  // them back for anyone auditing what was sent.
  //
  // Sorting by export date implies it: the archived rows are the only ones with
  // an export date at all, so filtering them out would sort an empty column and
  // return the working list in an order nobody asked for.
  const includeExported = sp.archived === '1' || sort === 'exported';

  let rows: RecordRow[] = [];
  let total = 0;
  try {
    const res = await getRecords({
      page,
      pageSize: PAGE_SIZE,
      source,
      bu,
      vertical,
      recordType,
      contactStatus,
      route,
      stage,
      band,
      status,
      completenessTier,
      ownerId,
      unassigned,
      ownerGroup,
      includeExported,
      sort,
      search,
    });
    rows = res.rows;
    total = res.total;
  } catch (err) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-16">
        <SupabaseNotConfigured detail={err instanceof Error ? err.message : String(err)} />
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, total);
  const base: SP = {
    source,
    bu,
    vertical,
    type: recordType,
    contact: contactStatus,
    route,
    stage,
    band,
    status,
    tier: completenessTier,
    mine,
    owner: sp.owner,
    owner_group: ownerGroup,
    sort,
    q: search,
    // Carried, so clicking any filter while auditing archived leads does not
    // silently drop them back out of the list.
    archived: sp.archived,
  };

  // `record` is deliberately absent from `base`, so the drawer's close link is
  // this same list with every filter intact and only the record dropped.
  const openRecord = sp.record ? await getRecordDetail(sp.record) : null;

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-foreground text-2xl font-bold">My Leads</h1>
          <p className="text-muted mt-1 text-sm">
            {total.toLocaleString()} records{source ? ` from ${source}` : ''}
            {total > 0 ? ` · showing ${first.toLocaleString()}–${last.toLocaleString()}` : ''}
          </p>
          {/*
            An owner filter arrives by link from a record drawer, so without this
            the user lands on a narrowed list with no visible cause and no way
            back. States what is filtering, how trustworthy the grouping is, and
            offers one click out.
          */}
          {ownerGroup ? (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={ownerGroup.startsWith('E:') ? 'success' : 'neutral'}>
                {ownerGroup.startsWith('E:') ? 'verified owner id' : 'matched by name'}
              </Badge>
              <span className="text-muted">
                showing one owner&rsquo;s leads · <span className="font-mono">{ownerGroup}</span>
              </span>
              <Link
                href={qs({ ...base, owner_group: undefined }, {})}
                className="text-brand underline underline-offset-2"
              >
                clear
              </Link>
            </p>
          ) : null}
        </div>
        <Link href="/control/sources" className="text-brand text-sm underline underline-offset-2">
          Source catalog
        </Link>
      </div>

      {/* filters */}
      <div className="mb-5 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-subtle text-xs font-medium">Source</span>
          <Chip href={qs(base, { source: undefined, page: undefined })} active={!source}>
            All
          </Chip>
          {SOURCE_CATALOG.map((s) => (
            <Chip
              key={s.sourceKey}
              href={qs(base, { source: source === s.sourceKey ? undefined : s.sourceKey, page: undefined })}
              active={source === s.sourceKey}
            >
              {s.sourceKey}
            </Chip>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-subtle text-xs font-medium">BU</span>
          <Chip href={qs(base, { bu: undefined, page: undefined })} active={!bu}>
            All
          </Chip>
          {BUSINESS_UNITS.map((b) => (
            <Chip key={b} href={qs(base, { bu: bu === b ? undefined : b, page: undefined })} active={bu === b}>
              {BU_SHORT[b]}
            </Chip>
          ))}
          <span className="text-subtle ml-3 text-xs font-medium">Type</span>
          {RECORD_TYPES.map((t) => (
            <Chip
              key={t}
              href={qs(base, { type: recordType === t ? undefined : t, page: undefined })}
              active={recordType === t}
            >
              {t}
            </Chip>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-subtle text-xs font-medium">Route</span>
          {ROUTES.map((r) => (
            <Chip key={r} href={qs(base, { route: route === r ? undefined : r, page: undefined })} active={route === r}>
              {r}
            </Chip>
          ))}
          <span className="text-subtle ml-3 text-xs font-medium">Stage</span>
          {STAGES.map((s) => (
            <Chip key={s} href={qs(base, { stage: stage === s ? undefined : s, page: undefined })} active={stage === s}>
              {s}
            </Chip>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-subtle text-xs font-medium">Priority</span>
          {PRIORITY_BANDS.map((b) => (
            <Chip
              key={b}
              href={qs(base, { band: band === b ? undefined : b, page: undefined })}
              active={band === b}
              title={BAND_LABELS[b]}
            >
              {b}
            </Chip>
          ))}
          <span className="text-subtle text-xs font-medium">Owner</span>
          <Chip href={qs(base, { mine: '1', owner: undefined, page: undefined })} active={mine === '1'}>
            Mine
          </Chip>
          {canSeeAll ? (
            <Chip
              href={qs(base, { mine: '0', owner: undefined, page: undefined })}
              active={mine === '0' && !unassigned}
            >
              Everyone
            </Chip>
          ) : null}
          <Chip href={qs(base, { mine: '0', owner: 'none', page: undefined })} active={unassigned}>
            Unassigned
          </Chip>

          <span className="text-subtle ml-3 text-xs font-medium">Status</span>
          {LEAD_STATUSES.map((st) => (
            <Chip
              key={st}
              href={qs(base, { status: status === st ? undefined : st, page: undefined })}
              active={status === st}
              title={STATUS_LABELS[st]}
            >
              {STATUS_LABELS[st]}
            </Chip>
          ))}
          <span className="text-subtle ml-3 text-xs font-medium">Sort</span>
          {(['priority', 'newest', 'value', 'exported'] as const).map((s) => (
            <Chip
              key={s}
              href={qs(base, { sort: s, page: undefined })}
              active={sort === s}
              title={s === 'exported' ? 'Most recently handed over to Apollo — includes archived leads' : undefined}
            >
              {s}
            </Chip>
          ))}

          <form action="/records" className="ml-auto flex gap-1">
            {Object.entries(base).map(([k, v]) =>
              v && k !== 'q' ? <input key={k} type="hidden" name={k} value={v} /> : null
            )}
            <input
              name="q"
              defaultValue={search ?? ''}
              placeholder="Search name…"
              className="border-border-strong bg-surface text-foreground rounded-lg border px-3 py-1.5 text-sm"
            />
            <button className="bg-brand text-brand-contrast hover:bg-brand-hover rounded-lg px-3 py-1.5 text-sm font-medium transition-colors">
              Go
            </button>
          </form>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No records match these filters"
          description="Widen the filters, or ingest from a source to populate the table."
          action={
            <Link href="/control/sources" className="text-brand text-sm underline">
              Search a source
            </Link>
          }
        />
      ) : (
        <TableShell>
          <Table>
            <THead>
              <tr>
                <Th>Pri</Th>
                <Th>How early</Th>
                <Th>Name</Th>
                <Th>Ref</Th>
                <Th>Source</Th>
                <Th>Type</Th>
                <Th>BU</Th>
                <Th>Vertical</Th>
                <Th>Country</Th>
                <Th align="right">Value / MW</Th>
                <Th align="right">Compl.</Th>
                <Th>Status</Th>
                <Th>Lane</Th>
                <Th>Contact</Th>
                <Th>SLA</Th>
              </tr>
            </THead>
            <TBody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td>
                    {r.priority_band ? (
                      <Badge
                        className={BAND_COLORS[r.priority_band]}
                        title={r.priority_reasons?.join(' · ') || BAND_LABELS[r.priority_band]}
                      >
                        {r.priority_band} · {r.priority_score}
                      </Badge>
                    ) : (
                      <span className="text-subtle text-[10px]">unscored</span>
                    )}
                  </Td>
                  {/*
                    How early we are arriving, next to the priority that decides
                    whether anyone looks. A high score on a project that is
                    already built is not a lead, and that was previously only
                    discoverable by opening the drawer and reading the phase.
                    The tooltip carries the basis, because a verdict inferred
                    from the phase alone must not read like one measured against
                    a real construction start date.
                  */}
                  <Td>
                    <ArrivalBadge record={r} />
                  </Td>
                  {/*
                    Every record opens its own detail drawer. This used to link
                    only when `account_key` was set — populated by Claude
                    enrichment alone — so 16,332 of 16,515 project records were
                    plain text with nothing to click. The account page is still
                    reachable, from inside the drawer, where it belongs: it
                    describes the company, not this record.
                  */}
                  <Td className="text-foreground font-medium">
                    <Link
                      href={qs(base, { record: r.id })}
                      prefetch={false}
                      scroll={false}
                      className="hover:underline"
                    >
                      {r.canonical_name}
                    </Link>
                  </Td>
                  <Td className="text-subtle font-mono text-[10px]">{r.ref_code ?? '—'}</Td>
                  <Td className="text-muted text-xs">{r.source_key}</Td>
                  <Td className="text-muted text-xs">{r.record_type ?? '—'}</Td>
                  <Td className="text-muted text-xs">{r.bu ? (BU_SHORT[r.bu] ?? r.bu) : '—'}</Td>
                  <Td className="text-muted text-xs">{r.vertical ? titleize(r.vertical) : '—'}</Td>
                  <Td className="text-muted text-xs">{r.country ?? '—'}</Td>
                  <Td align="right" className="text-foreground">
                    {r.estimated_value != null
                      ? money(r.estimated_value)
                      : r.capacity_mw != null
                        ? `${Math.round(r.capacity_mw).toLocaleString()} MW`
                        : '—'}
                  </Td>
                  <Td align="right" className="text-muted">
                    {r.population_percentage != null ? `${Math.round(r.population_percentage)}%` : '—'}
                  </Td>
                  {/*
                    Export outranks status. An archived lead still reads ASSIGNED
                    in the status column, so showing the status here would put a
                    lead that has left the building in the same cell state as one
                    a seller is expected to work. The date comes with the badge
                    because "when was this handed over" is the question anyone
                    looking at an archived row is actually asking — and `sort=exported`
                    orders by the same value they are reading.
                  */}
                  <Td>
                    {r.apollo_exported_at ? (
                      <Badge
                        tone="success"
                        title={`Archived — sent to Apollo on ${new Date(r.apollo_exported_at).toLocaleString('en-GB')}${
                          r.apollo_export_status ? ` · ${r.apollo_export_status}` : ''
                        }${r.status ? ` · lifecycle ${STATUS_LABELS[r.status as LeadStatus] ?? r.status}` : ''}`}
                      >
                        exported {exportDate(r.apollo_exported_at)}
                      </Badge>
                    ) : r.apollo_export_status === 'failed' ? (
                      // Not archived: a failed send stays in the queue, and the
                      // row must not look handed over.
                      <Badge tone="danger" title="The send to Apollo failed — still queued for the next run">
                        export failed
                      </Badge>
                    ) : r.status ? (
                      <Badge className={STATUS_COLORS[r.status as LeadStatus] ?? ''}>
                        {STATUS_LABELS[r.status as LeadStatus] ?? r.status}
                      </Badge>
                    ) : (
                      <span className="text-subtle text-[10px]">—</span>
                    )}
                  </Td>
                  <Td className="text-xs">
                    {r.route ? (
                      <span className={ROUTE_TEXT[r.route] ?? 'text-muted'}>
                        {r.route}
                        <span className="text-subtle">/{r.stage}</span>
                      </span>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </Td>
                  <Td>
                    <Badge className={CONTACT_STATUS_COLORS[r.contact_status ?? 'needs_enrichment']}>
                      {r.contact_status === 'has_contact' ? 'contact' : 'enrich'}
                    </Badge>
                  </Td>
                  <Td>
                    {r.sla_due_at ? (
                      <Badge tone={slaTone(r.sla_due_at, r.sla_breached)}>
                        {slaLabel(r.sla_due_at, r.sla_breached)}
                      </Badge>
                    ) : (
                      <span className="text-subtle text-[10px]">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </TBody>
          </Table>
        </TableShell>
      )}

      {pages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link
              href={qs(base, { page: String(page - 1) })}
              className="border-border-strong hover:bg-surface-raised rounded-lg border px-3 py-1.5"
            >
              ← Prev
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted">
            Page {page} of {pages.toLocaleString()}
          </span>
          {page < pages ? (
            <Link
              href={qs(base, { page: String(page + 1) })}
              className="border-border-strong hover:bg-surface-raised rounded-lg border px-3 py-1.5"
            >
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}

      {/*
        Rendered whenever `?record=` is present, even if the row could not be
        read — a deleted id, or one RLS does not grant this user. Saying so beats
        a drawer that opens empty or a click that appears to do nothing.
      */}
      {sp.record ? (
        <RecordDrawer title={openRecord?.canonical_name ?? 'Record'} closeHref={qs(base, { page: sp.page })}>
          {openRecord ? (
            <RecordDetail r={openRecord} />
          ) : (
            <p className="text-muted text-sm">
              This record could not be loaded. It may have been deleted, or it may sit outside the records your role can
              see.
            </p>
          )}
        </RecordDrawer>
      ) : null}
    </div>
  );
}
