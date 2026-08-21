import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import type { BuRollupRow } from '@/lib/queries';
import { BU_LABELS } from '@/lib/semantics';
import { Badge, Callout, Table, TBody, THead, Th, Td } from '@/components/ui';

/**
 * Reachable leads nobody can be given.
 *
 * A business unit can hold thousands of leads with contacts attached and have no
 * active assignee whose scope covers it. Every one of those is unassignable at any
 * quota — not "not yet assigned", but *cannot be*, until somebody's scope changes.
 * Measured on 20 August 2026: 3,227 of them, across four units.
 *
 *   export     63 reachable, 0 owners
 *   ireland   361 reachable, 0 owners
 *   uk      2,479 reachable, 0 owners
 *   apac      324 reachable, 0 owners
 *
 * BuStats already carried this — its own docblock says "the owners column is the
 * point of the table, not a footnote to it" — but it said it in a column of a
 * table below the fold, next to four other columns, on a page you had to scroll.
 * A number that means "3,227 leads are stuck and only an admin can unstick them"
 * is not a column. It is the most actionable fact on the dashboard.
 *
 * RENDERS NOTHING WHEN EVERY UNIT IS COVERED
 *
 * Deliberate: this is an alert, not a panel. A permanent card that usually says
 * "no problems" trains people to skip the place problems appear. When the scopes
 * are fixed it disappears, and its absence is the good news.
 */
export default function CoverageAlert({ rows }: { rows: BuRollupRow[] }) {
  /*
    Zero owners AND something to lose. A unit with no assignee and no reachable
    leads is a configuration detail, not a blocker — flagging it would put a red
    box on the dashboard for a unit nobody is waiting on.
  */
  const uncovered = rows
    .filter((r) => r.activeAssignees === 0 && r.reachable > 0)
    .sort((a, b) => b.reachable - a.reachable);

  if (uncovered.length === 0) return null;

  const stuck = uncovered.reduce((sum, r) => sum + r.reachable, 0);

  return (
    <Callout tone="danger" size="md">
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {stuck.toLocaleString()} reachable lead{stuck === 1 ? '' : 's'} cannot be assigned to anyone
          </p>
          <p className="mt-1 text-xs">
            {uncovered.length === 1 ? 'One business unit has' : `${uncovered.length} business units have`} no active
            assignee whose scope covers {uncovered.length === 1 ? 'it' : 'them'}. These leads have contacts and are
            ready to work — no quota change will move them, only a scope change will.
          </p>

          <div className="border-border-base bg-surface mt-3 overflow-hidden rounded-lg border">
            <Table>
              <THead>
                <tr>
                  <Th>Business unit</Th>
                  <Th align="right">Reachable</Th>
                  <Th align="right">Waiting</Th>
                  <Th>Coverage</Th>
                </tr>
              </THead>
              <TBody>
                {uncovered.map((r) => (
                  <tr key={r.bu}>
                    <Td>
                      <Link
                        href={`/records?bu=${r.bu}&mine=0`}
                        prefetch={false}
                        className="text-foreground font-medium hover:underline"
                      >
                        {BU_LABELS[r.bu] ?? r.bu}
                      </Link>
                    </Td>
                    <Td align="right">{r.reachable.toLocaleString()}</Td>
                    <Td align="right">{r.waiting.toLocaleString()}</Td>
                    <Td>
                      <Badge tone="danger">nobody</Badge>
                    </Td>
                  </tr>
                ))}
              </TBody>
            </Table>
          </div>

          {/*
            One link, to the one page that can fix it. "Assign them" would be a
            lie — there is nobody to assign them to, which is the whole finding.
          */}
          <p className="mt-3 text-xs">
            <Link href="/admin/team" className="font-semibold underline underline-offset-2">
              Widen someone&rsquo;s scope on Team &amp; Users →
            </Link>
          </p>
        </div>
      </div>
    </Callout>
  );
}
