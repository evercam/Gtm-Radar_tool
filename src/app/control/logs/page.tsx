import Link from 'next/link';
import { requirePermission } from '@/lib/auth/session';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { getEvents, getEventSummary } from '@/lib/observability/readEvents';
import { Card, CardHeader, CardBody, Badge, EmptyState, TableShell, Table, THead, TBody, Th, Td } from '@/components/ui';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';

export const dynamic = 'force-dynamic';

/**
 * The activity log — what the app did, after the fact.
 *
 * Every silent failure found in this codebase had the same shape: a read failed,
 * the failure went to console.warn, the caller wrote `?? 0`, and the page showed
 * a zero. The zero looked like an answer. console.warn only exists in a
 * serverless log stream that nobody tails and that rolls off, so by the time
 * anyone asked "why does this say nothing", there was nothing left to look at.
 *
 * This page is what is left to look at. Read-only, deliberately: there is no
 * button here that re-runs anything, because a retry button next to a row
 * describing a job that already half-ran is how a book gets exported twice.
 */

type SP = { kind?: string; outcome?: string; name?: string };

/** "2 m 04 s", "840 ms" — a duration you can compare at a glance. */
function humanDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} m ${String(Math.round(s - m * 60)).padStart(2, '0')} s`;
}

function humanWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * The detail column, as one line of `key=value`.
 *
 * Not pretty-printed JSON: the value of this table is scanning fifty rows for
 * the one that looks wrong, and a JSON block per row makes that impossible.
 * Objects collapse to their JSON so nothing is hidden, just compressed.
 */
function summariseDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return '—';
  const parts = Object.entries(detail)
    .filter(([, v]) => v != null && v !== '' && v !== false)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return parts.length ? parts.join('  ') : '—';
}

const KINDS = ['query', 'filter', 'cron', 'export', 'enrich', 'ingest', 'auth', 'mcp'];

export default async function LogsPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePermission('logs.view', '/control/logs');

  if (!isSupabaseServerConfigured()) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-16">
        <SupabaseNotConfigured />
      </div>
    );
  }

  const sp = await searchParams;
  const kind = KINDS.includes(sp.kind ?? '') ? sp.kind : undefined;
  const outcome = (['failed', 'ok'].includes(sp.outcome ?? '') ? sp.outcome : 'all') as 'failed' | 'ok' | 'all';

  const [{ rows, unavailable }, summary] = await Promise.all([
    getEvents({ kind, outcome, name: sp.name, limit: 200 }),
    getEventSummary(24),
  ]);

  /*
    An unreadable log and an empty log are different facts, and this page exists
    because returning the same thing for both is the bug. If the table is missing
    the migration has not been applied, which is a different instruction again.
  */
  if (unavailable && summary.unavailable) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-10">
        {/*
          Written out rather than using <MigrationRequired>, which hardcodes a
          message about the priority and enrichment columns — accurate for the
          pages it was built for and wrong here. Naming the wrong migration would
          send somebody to apply something unrelated.
        */}
        <Card>
          <CardHeader
            title="The activity log is not readable"
            subtitle="Which is not the same as nothing having happened."
          />
          <CardBody>
            <p className="text-sm">
              Apply <code className="font-mono text-[12px]">supabase/migrations/20260811140000_app_events.sql</code> and
              reload. Until it lands nothing is being recorded at all, so this page would be empty even on a day when
              something broke.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  const linkTo = (next: Partial<SP>) => {
    const p = new URLSearchParams();
    const merged = { kind, outcome: outcome === 'all' ? undefined : outcome, name: sp.name, ...next };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, String(v));
    const qs = p.toString();
    return qs ? `/control/logs?${qs}` : '/control/logs';
  };

  const failedNow = summary.kinds.reduce((n, k) => n + k.failed, 0);

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold">Activity Log</h1>
        <p className="text-subtle mt-1 text-sm">
          Failures, slow reads and the filters people applied. Successful work is only recorded when it was slow — every
          successful query would bury the ones that matter.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Last 24 hours"
          subtitle={
            failedNow > 0
              ? `${failedNow} failure${failedNow === 1 ? '' : 's'} recorded. Failures are kept for 90 days, everything else for 30.`
              : 'No failures recorded. Failures are kept for 90 days, everything else for 30.'
          }
        />
        <CardBody>
          {summary.unavailable ? (
            <p className="text-sm text-amber-400">The summary could not be read, so these totals are missing rather than zero.</p>
          ) : summary.kinds.length === 0 ? (
            <p className="text-subtle text-sm">Nothing recorded in the last 24 hours.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {summary.kinds.map((k) => (
                <Link
                  key={k.kind}
                  href={linkTo({ kind: k.kind, name: undefined })}
                  className="border-subtle hover:border-strong rounded-lg border px-3 py-2 text-sm"
                >
                  <span className="font-medium">{k.kind}</span>
                  <span className="text-subtle ml-2">{k.total}</span>
                  {k.failed > 0 ? <span className="ml-2 text-red-400">{k.failed} failed</span> : null}
                </Link>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={kind ? `${kind} events` : 'All events'}
          subtitle={sp.name ? `Filtered to ${sp.name}.` : 'Newest first, capped at 200.'}
          action={
            <div className="flex flex-wrap gap-2 text-xs">
              <Link href={linkTo({ kind: undefined, name: undefined })} className={kind ? 'text-subtle' : 'font-medium'}>
                All kinds
              </Link>
              <Link href={linkTo({ outcome: 'failed' })} className={outcome === 'failed' ? 'font-medium' : 'text-subtle'}>
                Failures
              </Link>
              <Link href={linkTo({ outcome: undefined })} className={outcome === 'all' ? 'font-medium' : 'text-subtle'}>
                Any outcome
              </Link>
            </div>
          }
        />
        <CardBody>
          {unavailable ? (
            <p className="text-sm text-amber-400">
              The event list could not be read. This is a failed query, not an empty log — reload to retry.
            </p>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No events match"
              description="Nothing has been recorded for this filter. Successful work under two seconds is not logged, so a quiet list is the normal state."
            />
          ) : (
            <TableShell>
              <Table>
                <THead>
                  <tr>
                    <Th>When</Th>
                    <Th>Kind</Th>
                    <Th>Name</Th>
                    <Th>Outcome</Th>
                    <Th>Took</Th>
                    <Th>Who</Th>
                    <Th>Detail</Th>
                  </tr>
                </THead>
                <TBody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <Td>{humanWhen(r.at)}</Td>
                      <Td>{r.kind}</Td>
                      <Td>
                        <Link href={linkTo({ name: r.name, kind: r.kind })} className="hover:underline">
                          {r.name}
                        </Link>
                      </Td>
                      <Td>
                        {r.ok === false ? (
                          <Badge tone="danger">failed</Badge>
                        ) : r.ok === true ? (
                          <Badge tone="success">ok</Badge>
                        ) : (
                          // A filter has no outcome. Rendering it as "ok" would
                          // claim something that was never measured.
                          <span className="text-subtle">—</span>
                        )}
                      </Td>
                      <Td>{humanDuration(r.duration_ms)}</Td>
                      <Td>{r.actor ?? <span className="text-subtle">scheduled</span>}</Td>
                      <Td>
                        <span className="text-subtle font-mono text-[11px]">{summariseDetail(r.detail)}</span>
                      </Td>
                    </tr>
                  ))}
                </TBody>
              </Table>
            </TableShell>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
