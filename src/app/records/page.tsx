import Link from 'next/link';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { getRecords, getRecordDetail, type RecordRow, type RecordSort } from '@/lib/queries';
import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { SOURCE_CATALOG } from '@/lib/sourceCatalog';
import { BAND_LABELS, BU_SHORT, BUSINESS_UNITS, RECORD_TYPES, ROUTES, STAGES } from '@/lib/semantics';
import { PRIORITY_BANDS } from '@/lib/priority';
import { LEAD_STATUSES, STATUS_LABELS } from '@/lib/lifecycle';
import { Badge, Callout, EmptyState, Table, TableShell, TBody, THead, Th, Td } from '@/components/ui';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import RecordDrawer from '@/components/RecordDrawer';
import { resolveColumns, type RecordCellContext } from '@/components/records/columns';
import {
  ActiveFilters,
  ColumnPicker,
  DATE_WINDOWS,
  DateWindowPicker,
  FilterDropdown,
  OwnerFilter,
  type FilterOption,
} from '@/components/table/TableControls';
import RecordDetail from '@/components/RecordDetail';
import { logEventAsync } from '@/lib/observability/events';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

/*
  The sort options, and the sentences the chips used to carry as tooltips.

  Kept verbatim: priority and intent are easy to confuse and the difference decides
  how a rep spends the morning, which is exactly the kind of explanation that gets
  dropped in a refactor and never noticed missing.
*/
const SORT_OPTIONS: FilterOption[] = [
  {
    value: 'priority',
    label: 'priority',
    title: 'Biggest first — value, capacity, ICP fit and key-account weighting',
  },
  {
    value: 'intent',
    label: 'intent',
    title:
      'Readiest first — timing verdict, then urgent stage, then a named trigger. Ties broken by priority.',
  },
  { value: 'newest', label: 'newest' },
  { value: 'value', label: 'value' },
  {
    value: 'exported',
    label: 'exported',
    title: 'Most recently handed over to Apollo — includes archived leads',
  },
];





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
    completenessTier = sp.tier,
    crmSignal = sp.crm,
    ownerGroup = sp.owner_group;
  // Sellers see their own book by default; managers and admins see everything
  // and opt into a narrower view. `mine=0` lets a seller look at the wider
  // pool their scope covers without pretending they own it.
  const canSeeAll = can(user, 'leads.view.all');
  const mine = sp.mine ?? (canSeeAll ? '0' : '1');
  const ownerId = mine === '1' ? user.id : undefined;
  const unassigned = sp.owner === 'none';
  const sort = (['priority', 'intent', 'newest', 'value', 'exported'].includes(sp.sort ?? '')
    ? sp.sort
    : 'priority') as RecordSort;
  // Exported leads are archived out of the working list. `archived=1` brings
  // them back for anyone auditing what was sent.
  //
  // Sorting by export date implies it: the archived rows are the only ones with
  // an export date at all, so filtering them out would sort an empty column and
  // return the working list in an order nobody asked for.
  const includeExported = sp.archived === '1' || sort === 'exported';

  /*
    The arrival window. Only the day count is resolved here — getRecords turns it
    into an instant, because reading a clock during render is impure.

    An unknown value is dropped rather than rejected: a stale bookmark showing the
    whole book is a small surprise, an error page is not.
  */
  const sinceDays = DATE_WINDOWS.find((w) => w.key === sp.since)?.days;


  let rows: RecordRow[] = [];
  /*
    null means the count could not be taken — see RecordsResult.total. It is not
    zero, and every place that prints it has to say so rather than render a
    reassuring number nobody measured.
  */
  let total: number | null = 0;
  let readFailed = false;
  let readError: string | null = null;
  /*
    Wall-clock timing for the telemetry below, and the three purity suppressions
    it needs.

    `react-hooks/purity` flags Date.now() in a component body because an impure
    read "can produce unstable results that update unpredictably when the
    component happens to re-render". That is the right rule and the wrong target
    here: RecordsPage is an ASYNC SERVER COMPONENT. It runs once per request, on
    the server, and awaits I/O — there is no re-render for a second reading to
    disagree with, and the value is never compared across renders. It is measuring
    how long getRecords took, which is the one thing a pure clock could not do.

    Suppressed rather than worked around. Hiding the call behind a module-scope
    helper would silence the rule by indirection while changing nothing, which is
    worse: the next reader would not know the rule had an opinion. Restructuring
    the telemetry to avoid a clock would mean losing the duration.
  */
  // eslint-disable-next-line react-hooks/purity -- async server component: runs once per request, never re-renders
  const queryStartedAt = Date.now();
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
      crmSignal,
      ownerId,
      unassigned,
      ownerGroup,
      includeExported,
      sort,
      search,
      sinceDays,
    });
    rows = res.rows;
    total = res.total;
    readFailed = res.failed;
    readError = res.error;
    /*
      Which filters people actually use, and what they got back.

      The reason to record this rather than just the failures: a filter
      combination that returns nothing looks the same to the operator as a bug,
      and the two are told apart by whether the same combination has ever
      returned rows. Without a record there is nothing to compare against, so
      "the tool shows no leads" is unanswerable.

      Only the filters that were set are stored — unset keys are dropped by the
      sanitiser, so the event shows what was chosen rather than the whole filter
      vocabulary with nulls in it.
    */
    logEventAsync({
      kind: 'filter',
      name: 'records.list',
      // eslint-disable-next-line react-hooks/purity -- see the note at queryStartedAt
      durationMs: Date.now() - queryStartedAt,
      actor: user.email,
      detail: {
        page,
        sort,
        total,
        returned: rows.length,
        mine,
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
        crm: crmSignal,
        owner_group: ownerGroup,
        unassigned: unassigned || undefined,
        archived: includeExported || undefined,
        // The search term is redacted for contact shapes on the way in, so a
        // colleague pasting an email into the box does not put it in the log.
        q: search,
      },
    });
  } catch (err) {
    logEventAsync({
      kind: 'filter',
      name: 'records.list',
      ok: false,
      // eslint-disable-next-line react-hooks/purity -- see the note at queryStartedAt
      durationMs: Date.now() - queryStartedAt,
      actor: user.email,
      detail: { page, sort, error: err instanceof Error ? err.message : String(err) },
    });
    return (
      <div className="mx-auto max-w-7xl px-6 py-16">
        <SupabaseNotConfigured detail={err instanceof Error ? err.message : String(err)} />
      </div>
    );
  }

  /*
    Paging off an unknown total.

    With no count there is no last page, so the pager cannot claim one. It falls
    back to "there is a next page if this one came back full", which is what a
    keyset pager would have said anyway, and the header stops printing a total it
    does not have.
  */
  const countable = total ?? null;
  const pages = countable === null ? page + (rows.length === PAGE_SIZE ? 1 : 0) : Math.max(1, Math.ceil(countable / PAGE_SIZE));
  const first = rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = countable === null ? (page - 1) * PAGE_SIZE + rows.length : Math.min(page * PAGE_SIZE, countable);
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
    crm: crmSignal,
    mine,
    owner: sp.owner,
    owner_group: ownerGroup,
    sort,
    q: search,
    // Carried, so clicking any filter while auditing archived leads does not
    // silently drop them back out of the list.
    archived: sp.archived,
    // The column choice travels with every other filter, so a link built
    // anywhere on this page keeps the table the reader configured.
    cols: sp.cols,
    since: sp.since,
  };

  /*
    Columns, and the two Ads-Manager controls that act on them.

    `cols` is resolved server-side, so the table is rendered once with the chosen
    set rather than shipped whole and hidden with CSS. A hidden column still costs
    the row's markup and still shows up in a copy-paste; not rendering it is the
    difference between a picker and a visibility toggle.
  */
  const columns = resolveColumns(sp.cols);
  const cellContext: RecordCellContext = { hrefFor: (id) => qs(base, { record: id }) };
  const hrefForCols = (keys: string[]) => qs(base, { cols: keys.length ? keys.join(',') : undefined, page: undefined });
  /*
    A window may carry a sort with it — see DateWindowPicker. Passed through the URL
    so the sort chips above the table visibly change rather than the order shifting
    under the reader.
  */
  const hrefForWindow = (key: string | undefined, forceSort?: string) =>
    qs(base, { since: key, page: undefined, ...(forceSort ? { sort: forceSort } : {}) });
  const hrefWithout = (key: string) => qs(base, { [key]: undefined, page: undefined });

  /*
    What is narrowing the list, as removable chips. With thirteen possible filters
    the state that matters is which ones are ON, and reading that off a row of
    dropdowns means opening all thirteen.
  */
  const activeFilters = (
    [
      { key: 'source', label: 'source', value: source },
      { key: 'bu', label: 'BU', value: bu },
      { key: 'vertical', label: 'vertical', value: vertical },
      { key: 'type', label: 'type', value: recordType },
      { key: 'contact', label: 'contact', value: contactStatus },
      { key: 'route', label: 'lane', value: route },
      { key: 'stage', label: 'stage', value: stage },
      { key: 'band', label: 'band', value: band },
      { key: 'status', label: 'status', value: status },
      { key: 'tier', label: 'tier', value: completenessTier },
      { key: 'crm', label: 'CRM', value: crmSignal },
      { key: 'owner_group', label: 'owner', value: ownerGroup },
      { key: 'q', label: 'search', value: search },
    ] as const
  ).flatMap((f) => (f.value ? [{ key: f.key, label: f.label, value: f.value }] : []));

  // `record` is deliberately absent from `base`, so the drawer's close link is
  // this same list with every filter intact and only the record dropped.
  const openRecord = sp.record ? await getRecordDetail(sp.record) : null;

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-foreground text-xl font-bold">My Leads</h1>
          <p className="text-muted mt-1 text-sm">
            {countable === null ? 'count unavailable' : `${countable.toLocaleString()} records`}
            {source ? ` from ${source}` : ''}
            {rows.length > 0 ? ` · showing ${first.toLocaleString()}–${last.toLocaleString()}` : ''}
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
      {/*
        The control row: what the table is showing, and the two dials that change
        it. Right-aligned and together, the way Ads Manager groups them — a date
        window on one side of the page and a column chooser on the other reads as
        two unrelated features.
      */}
      <div className="border-border-base mb-3 flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <ActiveFilters filters={activeFilters} hrefWithout={hrefWithout} />
        <div className="ml-auto flex items-center gap-2">
          <DateWindowPicker current={sp.since} hrefForWindow={hrefForWindow} />
          <ColumnPicker chosen={columns} hrefForCols={hrefForCols} />
        </div>
      </div>

        {/*
          Eight dropdowns and a search box, on one line.

          This was five wrapped rows of chips — roughly seventy of them, with the
          34 sources taking four rows on their own. Every option was visible at
          once, which sounds like an advantage and is not: the table began below
          the fold on a laptop, and "is anything filtering this list" meant
          scanning seventy pills for a tinted background.

          A closed dropdown states its own value, so the set of filters is one line
          and what is ON is answered by the chips above rather than by scanning.
        */}
        <div className="flex flex-wrap items-center gap-2">
          <FilterDropdown
            label="Source"
            current={source}
            options={SOURCE_CATALOG.map((s) => ({ value: s.sourceKey, label: s.sourceKey }))}
            hrefFor={(v) => qs(base, { source: v, page: undefined })}
          />
          <FilterDropdown
            label="BU"
            current={bu}
            options={BUSINESS_UNITS.map((b) => ({ value: b, label: BU_SHORT[b] ?? b }))}
            hrefFor={(v) => qs(base, { bu: v, page: undefined })}
          />
          <FilterDropdown
            label="Type"
            current={recordType}
            options={RECORD_TYPES.map((t) => ({ value: t, label: t }))}
            hrefFor={(v) => qs(base, { type: v, page: undefined })}
          />
          <FilterDropdown
            label="Route"
            current={route}
            options={ROUTES.map((r) => ({ value: r, label: r }))}
            hrefFor={(v) => qs(base, { route: v, page: undefined })}
          />
          <FilterDropdown
            label="Stage"
            current={stage}
            options={STAGES.map((st) => ({ value: st, label: st }))}
            hrefFor={(v) => qs(base, { stage: v, page: undefined })}
          />
          <FilterDropdown
            label="Priority"
            current={band}
            options={PRIORITY_BANDS.map((b) => ({ value: b, label: b, hint: BAND_LABELS[b] }))}
            hrefFor={(v) => qs(base, { band: v, page: undefined })}
          />
          {/*
            What the CRM already knows. `avoid` first because it is the only value
            here that should stop somebody working a lead — it is a do-not-call
            list a human maintained in Zoho, which nothing in this tool could see
            until now.
          */}
          <FilterDropdown
            label="CRM"
            current={crmSignal}
            options={[
              { value: 'avoid', label: 'avoid', hint: 'marked do-not-call in the CRM' },
              { value: 'customer', label: 'customer', hint: 'active Evercam customer' },
              { value: 'lapsed', label: 'lapsed', hint: 'former customer — warm re-entry' },
              { value: 'partner', label: 'partner', hint: 'installer or investor, not a prospect' },
              { value: 'known', label: 'known', hint: 'in the CRM, no strong verdict' },
              { value: 'any', label: 'any match', hint: 'every lead the CRM recognises' },
            ]}
            hrefFor={(v) => qs(base, { crm: v, page: undefined })}
          />
          <FilterDropdown
            label="Status"
            current={status}
            options={LEAD_STATUSES.map((st) => ({ value: st, label: STATUS_LABELS[st] }))}
            hrefFor={(v) => qs(base, { status: v, page: undefined })}
          />
          {/*
            Owner is not one parameter, so it is not a FilterDropdown.

            "Mine" sets mine=1, "Everyone" sets mine=0, and "Unassigned" sets
            mine=0 plus owner=none — three states across two parameters, where
            every other filter here is one value in one key. Squeezing it into the
            generic control would mean teaching that control about pairs to serve
            a single caller.
          */}
          <OwnerFilter
            mine={mine}
            unassigned={unassigned}
            canSeeAll={canSeeAll}
            hrefFor={(patch) => qs(base, { ...patch, page: undefined })}
          />
          <FilterDropdown
            label="Sort"
            current={sort}
            allLabel="Priority"
            options={SORT_OPTIONS}
            hrefFor={(v) => qs(base, { sort: v ?? 'priority', page: undefined })}
          />

          <form action="/records" className="ml-auto flex gap-1">
            {Object.entries(base).map(([k, v]) =>
              v && k !== 'q' ? <input key={k} type="hidden" name={k} value={v} /> : null
            )}
            <input
              name="q"
              defaultValue={search ?? ''}
              placeholder="Search name…"
              className="border-border-strong bg-surface text-foreground rounded-lg border px-2.5 py-1.5 text-[11px]"
            />
            <button className="bg-brand text-brand-contrast hover:bg-brand-hover rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors">
              Go
            </button>
          </form>
        </div>
      </div>

      {/*
        A failed read is not an empty result, and this is where the difference
        finally shows.

        getRecords used to collapse any non-missing-column failure into
        `{ rows: [], total: 0 }`, and this branch rendered "No records match these
        filters" over it. A statement timeout — reproducible today by asking for an
        exact count over a date-windowed 111k-row table — reached the reader as a
        confident empty list telling them to WIDEN their filters, when the honest
        instruction was to try again.

        The two states now render differently, and the failed one names the
        database's own message: the person looking at it is the one who can decide
        whether to retry or narrow the query.
      */}
      {readFailed ? (
        <Callout tone="danger" size="md">
          <p className="text-sm font-semibold">The record list could not be read</p>
          <p className="mt-1 text-xs">
            This is a failed query, not an empty result — the filters may be fine. Reload to retry, or narrow the
            filters if it keeps timing out.
          </p>
          {readError ? <p className="mt-2 font-mono text-[10px] opacity-80">{readError}</p> : null}
        </Callout>
      ) : rows.length === 0 ? (
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
                {columns.map((c) => (
                  <Th key={c.key} align={c.align}>
                    {c.label}
                  </Th>
                ))}
              </tr>
            </THead>
            <TBody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {columns.map((c) => (
                    <Td key={c.key} align={c.align} className={c.key === 'name' ? 'text-foreground font-medium' : undefined}>
                      {c.render(r, cellContext)}
                    </Td>
                  ))}
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
