import { requirePermission } from '@/lib/auth/session';
import { isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getExportRuns } from '@/lib/queries';
import { getUserProfiles } from '@/lib/auth/users';
import { Card, CardHeader, CardBody, Badge, EmptyState, TableShell, Table, THead, TBody, Th, Td } from '@/components/ui';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import MigrationRequired from '@/components/MigrationRequired';

export const dynamic = 'force-dynamic';

/**
 * What the export has actually done, run by run.
 *
 * `export_runs` has been written on every send since the feature shipped and read
 * by nothing, so the only way to find out whether a run happened was to trigger
 * another one. Apollo cannot answer it either: it emits no notification when
 * contacts are created, so a run that sent forty leads and a run nobody started
 * are indistinguishable from inside the CRM.
 *
 * Read-only on purpose. Nothing here re-runs an export — a button that resends
 * next to a row showing what was already sent is how a book gets exported twice.
 */

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
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default async function ExportHistoryPage() {
  await requirePermission('leads.export', '/control/exports');

  if (!isSupabaseServiceConfigured()) {
    return <SupabaseNotConfigured detail="Export history needs the Supabase service role key." />;
  }

  const [{ rows, tableMissing }, { users }] = await Promise.all([getExportRuns(50), getUserProfiles()]);
  const nameOf = (id: string | null) => {
    if (!id) return null;
    const u = users.find((x) => x.id === id);
    return u?.fullName || u?.email || null;
  };

  if (tableMissing) {
    return (
      <div>
        <h1 className="text-foreground mb-6 text-2xl font-bold">Export history</h1>
        <MigrationRequired feature="Export history" />
      </div>
    );
  }

  // Totals across what is shown, so the header is about this page rather than
  // implying an all-time figure the query never asked for.
  const totals = rows.reduce(
    (acc, r) => ({
      created: acc.created + r.created,
      existing: acc.existing + r.existing,
      failed: acc.failed + r.failed,
    }),
    { created: 0, existing: 0, failed: 0 }
  );

  return (
    <div>
      <h1 className="text-foreground text-2xl font-bold">Export history</h1>
      <p className="text-muted mb-6 mt-1 max-w-3xl text-sm">
        Every send to Apollo, newest first. Apollo does not notify anyone when contacts are created, so this is the
        record of what left the building and when.
      </p>

      <Card>
        <CardHeader
          title={`Runs (${rows.length})`}
          subtitle={
            rows.length
              ? `${totals.created.toLocaleString()} created · ${totals.existing.toLocaleString()} already there${
                  totals.failed ? ` · ${totals.failed.toLocaleString()} failed` : ''
                } across the runs below`
              : 'No export has been recorded yet'
          }
        />
        {rows.length === 0 ? (
          <CardBody>
            <EmptyState
              title="Nothing exported yet"
              description="Runs appear here as soon as an export is sent, whether it was triggered by hand or by the cron."
            />
          </CardBody>
        ) : (
          <TableShell>
            <Table>
              <THead>
                <tr>
                  <Th>When</Th>
                  <Th>Scope</Th>
                  <Th>Trigger</Th>
                  <Th align="right">Sent</Th>
                  <Th align="right">Created</Th>
                  <Th align="right">Existing</Th>
                  <Th align="right">Failed</Th>
                  <Th align="right">Batches</Th>
                  <Th align="right">Took</Th>
                  <Th>Status</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((r) => {
                  const who = nameOf(r.triggeredBy);
                  // The scope is the first question asked of a past run: a send
                  // "for Ronniel" and a send for everyone are different events.
                  const scope =
                    r.filters?.assignee ?? (r.filters?.bu ? `BU ${r.filters.bu}` : 'Everyone on the roster');
                  return (
                    <tr key={r.id}>
                      <Td>
                        <span className="text-foreground">{humanWhen(r.startedAt)}</span>
                        {who ? <span className="text-subtle block text-[11px]">by {who}</span> : null}
                      </Td>
                      <Td>{scope}</Td>
                      <Td>
                        <Badge tone={r.trigger === 'cron' ? 'info' : 'neutral'}>{r.trigger}</Badge>
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {r.requested.toLocaleString()}
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {r.created.toLocaleString()}
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {r.existing.toLocaleString()}
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {r.failed > 0 ? <span className="text-danger">{r.failed.toLocaleString()}</span> : '—'}
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {r.batches.toLocaleString()}
                      </Td>
                      <Td align="right" className="tabular-nums">
                        {humanDuration(r.durationMs)}
                      </Td>
                      <Td>
                        <Badge
                          tone={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}
                        >
                          {r.status}
                        </Badge>
                      </Td>
                    </tr>
                  );
                })}
              </TBody>
            </Table>
          </TableShell>
        )}
      </Card>

      {rows.some((r) => r.status === 'running') ? (
        <p className="text-warning mt-4 text-xs">
          A run still marked <span className="font-semibold">running</span> either is in flight now or was interrupted
          before it could close its row. Leads it did not send stay eligible, so the next run picks them up.
        </p>
      ) : null}
    </div>
  );
}
