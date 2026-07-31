import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { getAccountDetail } from '@/lib/queries';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import EnrichAction from '@/components/EnrichAction';
import RecordLink from '@/components/RecordLink';
import { BU_LABELS } from '@/lib/semantics';

export const dynamic = 'force-dynamic';

const titleize = (v: string) => v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
function mw(n: unknown): string {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? `${Math.round(x).toLocaleString()} MW` : '—';
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

export default async function AccountDetailPage({ params }: { params: Promise<{ key: string }> }) {
  if (!isSupabaseServerConfigured()) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-16">
        <SupabaseNotConfigured />
      </div>
    );
  }
  const { key } = await params;
  const { account, enrichment, view, projectCount, projects: records } = await getAccountDetail(
    decodeURIComponent(key)
  );

  // An account exists as soon as any record carries its key — that is what
  // /accounts lists from. Requiring a dedicated record_type='account' row here
  // 404'd every account known only through its projects, which is most of them
  // for adapter- and CSV-sourced data.
  if (!account && !enrichment && !view) notFound();

  const raw = (account?.raw_data ?? {}) as Record<string, unknown>;
  const assets = num(raw.assets);
  const pipeline = num(raw.pipeline);
  const operatingMW = num(raw.operating_mw);
  const trackers = (Array.isArray(raw.trackers) ? raw.trackers : []) as string[];
  const name = account?.canonical_name ?? enrichment?.account_name ?? view?.account_name ?? key;
  const score = enrichment?.key_account_score ?? view?.key_account_score ?? null;
  const isKey = enrichment?.key_account ?? view?.key_account ?? false;
  const reasons = enrichment?.key_account_reasons ?? view?.key_account_reasons ?? [];
  const verticals = view?.verticals ?? [];
  const bus = view?.bus ?? [];

  const related = enrichment?.related_entities ?? view?.related_entities ?? [];
  const parents = related.filter((e) => e.role === 'parent');
  const subs = related.filter((e) => e.role === 'subsidiary');
  const linkedProjects = enrichment?.related_projects ?? view?.related_projects ?? [];

  // Contacts live on the individual records for most accounts — the dedicated
  // account row is the exception, not the rule.
  const contacts = [
    ...(account?.contact_name || account?.contact_email
      ? [
          {
            name: account.contact_name,
            title: account.contact_title,
            email: account.contact_email,
            phone: account.contact_phone,
            context: null as string | null,
          },
        ]
      : []),
    ...records
      .filter((r) => r.contact_name || r.contact_email)
      .map((r) => ({
        name: r.contact_name,
        title: r.contact_title,
        email: r.contact_email,
        phone: r.contact_phone,
        context: r.canonical_name as string | null,
      })),
  ].filter((c, i, all) => all.findIndex((x) => (x.email ?? x.name) === (c.email ?? c.name)) === i);
  const hasContact = contacts.length > 0;

  const stat = (label: string, value: string | number, tone?: 'key' | 'gap') => (
    <div className="rounded-lg border border-border-base bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${tone === 'key' ? 'text-amber-600 dark:text-amber-400' : tone === 'gap' ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}`}
      >
        {value}
      </p>
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <Link href="/accounts" className="text-sm text-muted underline underline-offset-2 hover:text-foreground">
        ← Key Accounts
      </Link>

      {/* header */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-foreground">{name}</h1>
            {isKey ? (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                ★ KEY ACCOUNT{score != null ? ` · ${score}` : ''}
              </span>
            ) : null}
            {enrichment?.expansion_signal ? (
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                expanding
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted">
            {enrichment?.account_role || view?.account_role
              ? titleize((enrichment?.account_role ?? view?.account_role)!)
              : 'Account'}
            {account?.country ? ` · ${account.country}` : ''}
            {account?.bu
              ? ` · ${BU_LABELS[account.bu] ?? account.bu}`
              : bus.length
                ? ` · ${bus.map((b) => BU_LABELS[b] ?? b).join(', ')}`
                : ''}
            {account?.ref_code ? <span className="ml-2 font-mono text-xs text-muted">{account.ref_code}</span> : null}
          </p>
        </div>
        {account?.company_website ? (
          <a
            href={account.company_website}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-sky-600 underline underline-offset-2 dark:text-sky-400"
          >
            {account.company_website}
          </a>
        ) : null}
      </div>

      {/* portfolio stats */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stat('Records', (enrichment?.portfolio_project_count ?? view?.project_count ?? assets).toLocaleString())}
        {stat('With a contact', (view?.with_contact ?? (hasContact ? 1 : 0)).toLocaleString(), 'gap')}
        {stat('Operating', operatingMW > 0 ? mw(operatingMW) : pipeline > 0 ? pipeline.toLocaleString() : '—')}
        {stat('Verticals', trackers.length || verticals.length || (account?.vertical ? 1 : 0))}
      </div>

      {trackers.length || verticals.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(trackers.length ? trackers : verticals).map((t) => (
            <span key={t} className="rounded-full bg-surface-raised px-2.5 py-0.5 text-xs font-medium text-muted">
              {titleize(t)}
            </span>
          ))}
        </div>
      ) : null}

      {/* why key */}
      {reasons.length ? (
        <section className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Why it&rsquo;s a key account</h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {reasons.map((r, i) => (
              <li
                key={i}
                className="rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
              >
                {r}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        {/* corporate hierarchy */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Corporate hierarchy</h2>
          {parents.length || subs.length ? (
            <div className="mt-2 space-y-3">
              {parents.length ? (
                <div>
                  <p className="text-xs text-muted">Owned by</p>
                  <ul className="mt-1 space-y-1">
                    {parents.map((p, i) => (
                      <li key={i} className="text-sm text-foreground">
                        {p.name}
                        {p.share ? <span className="ml-1 text-xs text-muted">{p.share}%</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {subs.length ? (
                <div>
                  <p className="text-xs text-muted">Subsidiaries ({subs.length})</p>
                  <ul className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                    {subs.slice(0, 24).map((s, i) => (
                      <li key={i} className="truncate text-sm text-muted" title={s.name}>
                        {s.name}
                        {s.share ? <span className="ml-1 text-xs text-muted">{s.share}%</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">No hierarchy on record. Enrich to resolve it via GLEIF.</p>
          )}
        </section>

        {/* related projects */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Projects {projectCount > 0 ? `(${projectCount})` : ''}
          </h2>
          {records.length ? (
            <ul className="mt-2 space-y-1.5">
              {records.slice(0, 12).map((r) => (
                <li key={r.id} className="text-sm">
                  {/*
                    Was a keyword search for the record's own name, which is a
                    guess: it could match a dozen similarly-named sites or, once
                    the name contained punctuation, none at all. The id is right
                    here — open the record itself.
                  */}
                  <RecordLink id={r.id}>
                    <span className="text-foreground">{r.canonical_name}</span>
                  </RecordLink>
                  {r.current_phase ? (
                    <span className="text-muted ml-2 rounded bg-surface-raised px-1.5 py-0.5 text-[10px]">
                      {r.current_phase}
                    </span>
                  ) : null}
                </li>
              ))}
              {projectCount > 12 ? <li className="text-subtle text-xs">+{projectCount - 12} more</li> : null}
            </ul>
          ) : linkedProjects.length ? (
            <ul className="mt-2 space-y-1.5">
              {linkedProjects.slice(0, 12).map((p, i) => (
                <li key={i} className="text-sm">
                  <span className="text-foreground">{p.name}</span>
                  {p.stage ? (
                    <span className="text-muted ml-2 rounded bg-surface-raised px-1.5 py-0.5 text-[10px]">
                      {p.stage}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted mt-2 text-sm">No individual assets imported yet.</p>
          )}
        </section>
      </div>

      {/* contacts / enrichment */}
      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Contacts &amp; outreach</h2>
        {hasContact ? (
          <ul className="divide-border-base border-border-base mt-2 divide-y rounded-lg border bg-surface">
            {contacts.map((c, i) => (
              <li key={i} className="p-4 text-sm">
                <p className="text-foreground font-medium">
                  {c.name}
                  {c.title ? <span className="text-muted ml-1">· {c.title}</span> : null}
                </p>
                {c.email ? (
                  <a href={`mailto:${c.email}`} className="block text-sky-600 dark:text-sky-400">
                    {c.email}
                  </a>
                ) : null}
                {c.phone ? <span className="text-muted block">{c.phone}</span> : null}
                {c.context ? <p className="text-subtle mt-0.5 text-xs">on {c.context}</p> : null}
              </li>
            ))}
            {account?.opening_hook ? (
              <li className="p-4">
                <p className="text-muted border-l-2 border-indigo-300 pl-2 italic dark:border-indigo-700">
                  &ldquo;{account.opening_hook}&rdquo;
                </p>
              </li>
            ) : null}
          </ul>
        ) : (
          <div className="mt-2">
            <p className="mb-3 text-sm text-muted">
              No contact yet. Enrich to resolve the company via GLEIF + Claude and pull verified decision-makers via
              Apollo (energy-owner roles).
            </p>
            <EnrichAction
              record={{
                id: account?.id ?? records[0]?.id,
                canonical_name: name,
                record_type: account?.record_type ?? records[0]?.record_type ?? 'account',
                icp_code: account?.icp_code ?? records[0]?.icp_code,
                company_name_raw: account?.company_name_raw ?? records[0]?.company_name_raw ?? name,
                company_website: account?.company_website ?? records[0]?.company_website,
                country: account?.country ?? records[0]?.country,
                source_key: account?.source_key ?? records[0]?.source_key,
              }}
            />
          </div>
        )}
      </section>
    </div>
  );
}
