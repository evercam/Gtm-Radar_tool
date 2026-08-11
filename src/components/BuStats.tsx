import type { BuRollupRow } from '@/lib/queries';
import { BU_LABELS } from '@/lib/semantics';
import { Table, THead, TBody, Th, Td, Badge } from '@/components/ui';

/**
 * Stock per business unit, next to whether anybody can work it.
 *
 * The BU × vertical grid lower down the page answers "what have we got". This
 * answers the question that actually decides throughput, and which nothing on
 * the dashboard showed: a business unit can hold thousands of reachable leads
 * and have no active assignee whose scope covers it, and then every one of them
 * is unassignable at any quota.
 *
 * That is not hypothetical here. Every active person is scoped to `usa`, while
 * the NESO projects are `uk`, Calgary is `export` and the Australian news is
 * `apac` — so the owners column is the point of the table, not a footnote to it.
 *
 * Server component: it receives aggregated rows and only renders them.
 */

const n = (v: number) => v.toLocaleString('en-US');

export default function BuStats({ rows, truncated }: { rows: BuRollupRow[]; truncated: boolean }) {
  if (rows.length === 0) {
    return <p className="text-muted text-sm">No leads ingested yet.</p>;
  }

  const stranded = rows.filter((r) => r.activeAssignees === 0 && r.waiting > 0);
  const strandedLeads = stranded.reduce((s, r) => s + r.waiting, 0);

  return (
    <div>
      {strandedLeads > 0 ? (
        <p className="border-border-base bg-surface-raised text-body mb-3 rounded-lg border px-3 py-2 text-xs">
          <span className="text-foreground font-semibold">{n(strandedLeads)} reachable leads cannot be assigned.</span>{' '}
          No active assignee&rsquo;s scope covers {stranded.map((r) => BU_LABELS[r.bu] ?? r.bu).join(', ')}. Raising a
          quota will not move them — somebody has to cover the business unit, on{' '}
          <a href="/control/team" className="underline underline-offset-2">
            Team
          </a>
          .
        </p>
      ) : null}

      <Table>
        <THead>
          <tr>
            <Th>Business unit</Th>
            <Th align="right">Projects</Th>
            <Th align="right">Reachable</Th>
            <Th align="right">Waiting</Th>
            <Th align="right">Assigned</Th>
            <Th align="right">In Apollo</Th>
            <Th align="right">Can receive</Th>
          </tr>
        </THead>
        <TBody>
          {rows.map((r) => {
            const label = BU_LABELS[r.bu] ?? r.bu;
            const orphaned = r.activeAssignees === 0;
            return (
              <tr key={r.bu}>
                <Td>
                  <span className="text-foreground font-medium">{label}</span>
                </Td>
                <Td className="text-right font-mono text-xs">{n(r.total)}</Td>
                {/* Reachable, not total, is the number worth acting on — most of
                    the stock has no contact until enrichment runs. */}
                <Td className="text-right font-mono text-xs">{n(r.reachable)}</Td>
                <Td className="text-right font-mono text-xs">{r.waiting > 0 ? n(r.waiting) : '—'}</Td>
                <Td className="text-right font-mono text-xs">{r.assigned > 0 ? n(r.assigned) : '—'}</Td>
                <Td className="text-right font-mono text-xs">{r.exported > 0 ? n(r.exported) : '—'}</Td>
                <Td className="text-right">
                  {orphaned ? (
                    <Badge tone={r.waiting > 0 ? 'danger' : 'neutral'}>nobody</Badge>
                  ) : (
                    <span className="font-mono text-xs">
                      {r.activeAssignees} {r.activeAssignees === 1 ? 'person' : 'people'}
                    </span>
                  )}
                </Td>
              </tr>
            );
          })}
        </TBody>
      </Table>

      <p className="text-subtle mt-2 text-[11px]">
        <span className="font-semibold">Waiting</span> is reachable and unassigned — the workable backlog.{' '}
        <span className="font-semibold">Can receive</span> counts active roster members whose scope covers the unit; an
        empty scope covers every unit.
        {truncated ? ' Counts stopped at the page cap and are a floor, not a total.' : ''}
      </p>
    </div>
  );
}
