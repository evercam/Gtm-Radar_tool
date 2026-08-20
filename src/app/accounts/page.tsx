import Link from 'next/link';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { statusText } from '@/lib/status-colors';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { getAccounts, type AccountViewRow } from '@/lib/queries';
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

  let rows: AccountViewRow[] = [];
  let total = 0;
  try {
    const res = await getAccounts({ page, pageSize: PAGE_SIZE, keyOnly, bu, vertical, search });
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
  const base: SP = { key: keyOnly ? '1' : undefined, bu, vertical, q: search };
  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-medium ${active ? 'bg-brand text-white' : 'bg-surface-raised text-muted hover:bg-surface-raised'}`;

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

      {/* filters */}
      <div className="mb-5 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={qs(base, { key: keyOnly ? undefined : '1', page: undefined })} className={chip(keyOnly)}>
            ★ Key only
          </Link>
          <span className="mx-1 text-muted">|</span>
          <Link href={qs(base, { bu: undefined, page: undefined })} className={chip(!bu)}>
            All BUs
          </Link>
          {BUS.map((b) => (
            <Link key={b} href={qs(base, { bu: bu === b ? undefined : b, page: undefined })} className={chip(bu === b)}>
              {BU_LABELS[b]}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={qs(base, { vertical: undefined, page: undefined })} className={chip(!vertical)}>
            All verticals
          </Link>
          {VERTICALS.map((v) => (
            <Link
              key={v}
              href={qs(base, { vertical: vertical === v ? undefined : v, page: undefined })}
              className={chip(vertical === v)}
            >
              {titleize(v)}
            </Link>
          ))}
          <form action="/accounts" className="ml-auto flex gap-1">
            {keyOnly ? <input type="hidden" name="key" value="1" /> : null}
            {bu ? <input type="hidden" name="bu" value={bu} /> : null}
            {vertical ? <input type="hidden" name="vertical" value={vertical} /> : null}
            <input
              name="q"
              defaultValue={search ?? ''}
              placeholder="Search account…"
              className="rounded border border-border-strong bg-surface px-2 py-1 text-sm"
            />
            <button className="rounded bg-brand px-3 py-1 text-sm font-medium text-white">Go</button>
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
