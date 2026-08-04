import Link from 'next/link';
import type { HandoverBreakdown } from '@/lib/queries';
import { Card, CardHeader, CardBody, Badge, EmptyState, TableShell, Table, THead, TBody, Th, Td } from '@/components/ui';

/**
 * Who received leads, and what is waiting to reach them.
 *
 * The Dashboard could say how much had been handed over but not to whom, and not
 * what was queued behind it — so "the export sent nothing" and "there was nothing
 * left to send" looked identical. That is the question actually asked after a run,
 * and answering it needed both halves side by side.
 *
 * The columns are ordered as the lead travels: received, ready, then the reasons
 * it is not ready. Each lead is counted under its FIRST blocking reason, so the
 * row sums to that person's book instead of double-counting it.
 */
export default function HandoverByPerson({ breakdown }: { breakdown: HandoverBreakdown }) {
  const { rows, unrostered, requireVerified, tableMissing } = breakdown;

  const totals = rows.reduce(
    (a, r) => ({
      received: a.received + r.received,
      ready: a.ready + r.ready,
      waiting: a.waiting + r.waitingOnContact,
      unverified: a.unverified + r.blockedUnverified,
      dnc: a.dnc + r.doNotContact,
    }),
    { received: 0, ready: 0, waiting: 0, unverified: 0, dnc: 0 }
  );

  return (
    <Card>
      <CardHeader
        title="Handover by person"
        subtitle={
          tableMissing
            ? 'The roster table is missing — run the assignees migration.'
            : `${totals.received.toLocaleString()} received · ${totals.ready.toLocaleString()} ready to send · ${totals.waiting.toLocaleString()} waiting on a contact`
        }
        action={
          <Link href="/control/exports" className="text-brand text-xs underline">
            Run history
          </Link>
        }
      />
      {rows.length === 0 ? (
        <CardBody>
          <EmptyState
            title="Nobody holds a lead yet"
            description="Assign leads on Team & Users, then this shows who received them and what is queued behind."
          />
        </CardBody>
      ) : (
        <>
          <TableShell>
            <Table>
              <THead>
                <tr>
                  <Th>Person</Th>
                  <Th align="right">Received</Th>
                  <Th align="right">Ready</Th>
                  <Th align="right">No contact</Th>
                  {/* Only shown when the policy can actually block on it. */}
                  {requireVerified ? <Th align="right">Unverified</Th> : null}
                  <Th align="right">DNC</Th>
                  <Th align="right">Quota</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <tr key={r.assigneeId}>
                    <Td>
                      <span className="text-foreground">{r.name}</span>
                      {/* An inactive person can still hold leads, and those leads
                          are going nowhere — the export skips them. Saying so here
                          is the only place it surfaces. */}
                      {!r.isActive ? (
                        <Badge tone="warning" className="ml-2">
                          inactive
                        </Badge>
                      ) : null}
                      {r.isActive && r.dailyQuota === 0 ? (
                        <Badge tone="danger" className="ml-2">
                          quota 0
                        </Badge>
                      ) : null}
                    </Td>
                    <Td align="right">{r.received.toLocaleString()}</Td>
                    <Td align="right">
                      {r.ready > 0 ? <span className="text-success">{r.ready.toLocaleString()}</span> : '—'}
                    </Td>
                    <Td align="right">
                      {r.waitingOnContact > 0 ? (
                        <span className="text-muted">{r.waitingOnContact.toLocaleString()}</span>
                      ) : (
                        '—'
                      )}
                    </Td>
                    {requireVerified ? (
                      <Td align="right">
                        {r.blockedUnverified > 0 ? (
                          <span className="text-warning">{r.blockedUnverified.toLocaleString()}</span>
                        ) : (
                          '—'
                        )}
                      </Td>
                    ) : null}
                    <Td align="right">{r.doNotContact > 0 ? r.doNotContact.toLocaleString() : '—'}</Td>
                    <Td align="right">{r.dailyQuota.toLocaleString()}</Td>
                  </tr>
                ))}
              </TBody>
            </Table>
          </TableShell>
          <CardBody>
            <p className="text-subtle text-xs">
              <span className="text-foreground font-semibold">Ready</span> uses exactly the export&rsquo;s own gates, so
              it is what the next run would actually send — capped per person by their quota.{' '}
              <span className="text-foreground font-semibold">No contact</span> is not the export failing: those leads
              have no address, so they are enrichment&rsquo;s queue, not the export&rsquo;s.
              {requireVerified ? (
                <>
                  {' '}
                  <span className="text-foreground font-semibold">Unverified</span> leads have an address the policy
                  will not send — turn off &ldquo;Require a validated phone or email&rdquo; in Settings to release them.
                </>
              ) : null}
            </p>
            {unrostered > 0 ? (
              <p className="text-warning mt-2 text-xs">
                {unrostered.toLocaleString()} lead{unrostered === 1 ? '' : 's'} assigned to somebody no longer on the
                roster. The export skips them, so nobody is working them — reassign them on{' '}
                <Link href="/control/team" className="underline">
                  Team &amp; Users
                </Link>
                .
              </p>
            ) : null}
          </CardBody>
        </>
      )}
    </Card>
  );
}
