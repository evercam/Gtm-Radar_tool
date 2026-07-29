import Link from 'next/link';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { getRecords, type RecordRow, type RecordSort } from '@/lib/queries';
import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { SOURCE_CATALOG } from '@/lib/sourceCatalog';
import {
  BAND_COLORS,
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

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

function money(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
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
    completenessTier = sp.tier;
  // Sellers see their own book by default; managers and admins see everything
  // and opt into a narrower view. `mine=0` lets a seller look at the wider
  // pool their scope covers without pretending they own it.
  const canSeeAll = can(user.role, 'leads.view.all');
  const mine = sp.mine ?? (canSeeAll ? '0' : '1');
  const ownerId = mine === '1' ? user.id : undefined;
  const unassigned = sp.owner === 'none';
  const sort = (['priority', 'newest', 'value'].includes(sp.sort ?? '') ? sp.sort : 'priority') as RecordSort;

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
    sort,
    q: search,
  };

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-foreground text-2xl font-bold">My Leads</h1>
          <p className="text-muted mt-1 text-sm">
            {total.toLocaleString()} records{source ? ` from ${source}` : ''}
            {total > 0 ? ` · showing ${first.toLocaleString()}–${last.toLocaleString()}` : ''}
          </p>
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
          {(['priority', 'newest', 'value'] as const).map((s) => (
            <Chip key={s} href={qs(base, { sort: s, page: undefined })} active={sort === s}>
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
                  <Td className="text-foreground font-medium">
                    {r.account_key ? (
                      <Link
                        href={`/accounts/${encodeURIComponent(r.account_key)}`}
                        prefetch={false}
                        className="hover:underline"
                      >
                        {r.canonical_name}
                      </Link>
                    ) : (
                      r.canonical_name
                    )}
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
                  <Td>
                    {r.status ? (
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
    </div>
  );
}
