import Link from 'next/link';
import { ActiveFilters, FilterDropdown } from '@/components/table/TableControls';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { statusText } from '@/lib/status-colors';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { getAccounts, type AccountViewRow, type AccountsSort } from '@/lib/queries';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import { BU_SHORT as BU_LABELS } from '@/lib/semantics';

export const dynamic = 'force-dynamic';

const BUS = ['usa', 'uk', 'ireland', 'apac', 'export'];
const VERTICALS = ['coal', 'oil_gas', 'solar', 'wind', 'hydro', 'nuclear', 'bioenergy', 'mining', 'steel', 'cement'];
const PAGE_SIZE = 100;

function money(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}
const titleize = (v: string) => v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

type SP = Record<string, string | undefined>;
function qs(base: SP, patch: SP): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...patch })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `/accounts?${s}` : '/accounts';
}

export default async function AccountsPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!isSupabaseServerConfigured()) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-16">
        <SupabaseNotConfigured />
      </div>
    );
  }
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const keyOnly = sp.key === '1';
  const bu = sp.bu;
  const vertical = sp.vertical;
  const search = sp.q;
  /*
    Three filters this page did not have, chosen by looking at the data rather than
    by listing the columns.

    `contact` is the one that matters: sampled across 1,000 of 6,629 accounts, only
    77 have a single contact between them. Without it the table is 92% companies
    nobody can ring.

    A Role filter was considered and dropped — account_role holds `owner` (819 of
    that sample) or nothing, so the control would have had one option.
  */
  const contact = sp.contact === 'yes' || sp.contact === 'no' ? sp.contact : undefined;
  const expansion = sp.expansion === 'yes' || sp.expansion === 'no' ? sp.expansion : undefined;
  const sort = (['score', 'value', 'projects', 'name'] as const).includes(sp.sort as AccountsSort)
    ? (sp.sort as AccountsSort)
    : 'score';

  let rows: AccountViewRow[] = [];
  let total = 0;
  try {
    const res = await getAccounts({ page, pageSize: PAGE_SIZE, keyOnly, bu, vertical, search, contact, expansion, sort });
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
    key: keyOnly ? '1' : undefined,
    bu,
    vertical,
    q: search,
    contact,
    expansion,
    sort: sort === 'score' ? undefined : sort,
  };

  /*
    What is narrowing the list, as removable chips — the same control /records uses.

    This page had its own `chip()` helper producing className strings, which was a
    third hand-rolled copy of a pattern the Chip primitive and the records page
    already had. Sharing the dropdowns removes the copy rather than adding a fourth.
  */
  const activeFilters = (
    [
      { key: 'key', label: 'key accounts', value: keyOnly ? 'only' : undefined },
      { key: 'bu', label: 'BU', value: bu ? (BU_LABELS[bu] ?? bu) : undefined },
      { key: 'vertical', label: 'vertical', value: vertical ? titleize(vertical) : undefined },
      { key: 'contact', label: 'contact', value: contact === 'yes' ? 'has one' : contact === 'no' ? 'none' : undefined },
      { key: 'expansion', label: 'expansion', value: expansion === 'yes' ? 'signalled' : expansion === 'no' ? 'none' : undefined },
      { key: 'q', label: 'search', value: search },
    ] as const
  ).flatMap((f) => (f.value ? [{ key: f.key, label: f.label, value: f.value }] : []));

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Key Accounts</h1>
          <p className="mt-1 text-sm text-muted">
            {total.toLocaleString()} accounts · showing {first.toLocaleString()}–{last.toLocaleString()}
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link href="/control/sources" className="text-muted underline underline-offset-2 hover:text-foreground">
            Import
          </Link>
          <Link href="/control/sources" className="text-muted underline underline-offset-2 hover:text-foreground">
            the Source Hub
          </Link>
        </div>
      </div>

      {/*
        One row of dropdowns, plus the chips saying what is on.

        This was two rows of hand-rolled chip links — every BU and every vertical
        rendered at once, with a local `chip()` helper that was a third copy of a
        pattern the design system already had. The controls are the shared ones
        /records uses, so the two tables now behave the same way and there is one
        set of behaviours to keep in step.
      */}
      <div className="border-border-base mb-4 space-y-2 border-b pb-3">
        <ActiveFilters filters={activeFilters} hrefWithout={(k) => qs(base, { [k]: undefined, page: undefined })} />

        <div className="flex flex-wrap items-center gap-2">
          <FilterDropdown
            label="Key"
            current={keyOnly ? '1' : undefined}
            allLabel="All accounts"
            options={[{ value: '1', label: '★ Key accounts only' }]}
            hrefFor={(v) => qs(base, { key: v, page: undefined })}
          />
          <FilterDropdown
            label="BU"
            current={bu}
            options={BUS.map((b) => ({ value: b, label: BU_LABELS[b] ?? b }))}
            hrefFor={(v) => qs(base, { bu: v, page: undefined })}
          />
          <FilterDropdown
            label="Vertical"
            current={vertical}
            options={VERTICALS.map((v) => ({ value: v, label: titleize(v) }))}
            hrefFor={(v) => qs(base, { vertical: v, page: undefined })}
          />
          {/*
            The filter that changes how this page reads. 92% of accounts have
            nobody to call, so "has a contact" is the difference between a
            prospecting list and a directory.
          */}
          <FilterDropdown
            label="Contact"
            current={contact}
            allLabel="Any"
            options={[
              { value: 'yes', label: 'Has a contact', hint: 'reachable' },
              { value: 'no', label: 'No contact', hint: 'needs enrichment' },
            ]}
            hrefFor={(v) => qs(base, { contact: v, page: undefined })}
          />
          <FilterDropdown
            label="Expansion"
            current={expansion}
            allLabel="Any"
            options={[
              { value: 'yes', label: 'Signalled' },
              { value: 'no', label: 'No signal' },
            ]}
            hrefFor={(v) => qs(base, { expansion: v, page: undefined })}
          />
          <FilterDropdown
            label="Sort"
            current={sort === 'score' ? undefined : sort}
            allLabel="Key score"
            options={[
              { value: 'value', label: 'Total value', title: 'Null on 92% of accounts — this narrows as much as it sorts' },
              { value: 'projects', label: 'Project count' },
              { value: 'name', label: 'Name' },
            ]}
            hrefFor={(v) => qs(base, { sort: v, page: undefined })}
          />

          <form action="/accounts" className="ml-auto flex gap-1">
            {Object.entries(base).map(([k, v]) =>
              v && k !== 'q' ? <input key={k} type="hidden" name={k} value={v} /> : null
            )}
            <input
              name="q"
              defaultValue={search ?? ''}
              placeholder="Search account…"
              className="border-border-strong bg-surface text-foreground rounded-lg border px-2.5 py-1.5 text-[11px]"
            />
            <button className="bg-brand text-brand-contrast hover:bg-brand-hover rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors">
              Go
            </button>
          </form>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-surface p-8 text-center">
          <p className="text-sm text-muted">
            No accounts match. Clear filters, or{' '}
            <Link href="/control/sources" className="underline">
              import a list
            </Link>
            .
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-base bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-raised text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2">Account</th>
                <th className="px-4 py-2 text-right">Score</th>
                <th className="px-4 py-2 text-right">Assets</th>
                <th className="px-4 py-2 text-right">Contacts</th>
                <th className="px-4 py-2 text-right">Value / MW</th>
                <th className="px-4 py-2">Verticals</th>
                <th className="px-4 py-2">Regions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-base">
              {rows.map((a) => {
                const related = Array.isArray(a.related_projects) ? a.related_projects.length : 0;
                return (
                  <tr key={a.account_key} className="align-top">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/accounts/${encodeURIComponent(a.account_key)}`}
                          prefetch={false}
                          className="font-medium text-foreground hover:underline"
                        >
                          {a.account_name ?? a.account_key}
                        </Link>
                        {a.key_account ? (
                          <Badge tone="brand" title={(a.key_account_reasons ?? []).join(' · ')}>
                            ★ KEY
                          </Badge>
                        ) : null}
                        {a.expansion_signal ? (
                          <Badge tone="success" title={a.expansion_signal}>
                            expanding
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-muted">
                        {a.account_role ? titleize(a.account_role) : '—'}
                        {related > 0 ? ` · ${related} related` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {a.key_account_score != null ? (
                        <span
                          className={cn('font-semibold tabular-nums', a.key_account ? 'text-brand' : 'text-muted')}
                        >
                          {a.key_account_score}
                        </span>
                      ) : (
                        <span className="text-xs text-subtle">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-foreground">
                      {a.portfolio_project_count ?? a.project_count}
                    </td>
                    <td className={cn('px-4 py-2 text-right tabular-nums', statusText.success)}>
                      {a.with_contact || '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-foreground">
                      {a.total_value != null
                        ? money(a.total_value)
                        : a.capacity_mw != null
                          ? `${Math.round(a.capacity_mw).toLocaleString()} MW`
                          : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted">
                      {(a.verticals ?? []).filter(Boolean).slice(0, 3).map(titleize).join(', ') || '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted">
                      {(a.bus ?? [])
                        .filter(Boolean)
                        .map((b) => BU_LABELS[b] ?? b)
                        .join(', ') || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* pagination */}
      {pages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link
              href={qs(base, { page: String(page - 1) })}
              className="rounded border border-border-strong px-3 py-1.5 hover:bg-surface-raised"
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
              className="rounded border border-border-strong px-3 py-1.5 hover:bg-surface-raised"
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
