'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardBody, Button, Badge, ProgressBar } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

interface AssignResponse {
  ok: boolean;
  message: string;
  assigned?: number;
  atCapacity?: number;
  unassigned?: number;
  candidates?: number;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
  assignedToday: number;
  dailyQuota: number;
  openLeads: number;
  breached: number;
}

/**
 * Distribution: run the assignment rules, and see where the team's load
 * actually sits. Capacity is shown alongside the button because a run that
 * assigns nothing is almost always "everyone is at quota", not a broken rule.
 */
export default function AssignRunner({ team, isDefaultRules }: { team: TeamMember[]; isDefaultRules: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AssignResponse | null>(null);

  async function run() {
    setBusy(true);
    setRes(null);
    try {
      const r = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'autoAssign' }),
      });
      const json = (await r.json()) as AssignResponse;
      setRes(json);
      toast.show(json.message, json.ok ? 'success' : 'error');
      if (json.ok) router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setRes({ ok: false, message });
      toast.show(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const totalCapacity = team.reduce((sum, m) => sum + Math.max(0, m.dailyQuota - m.assignedToday), 0);

  return (
    <Card>
      <CardHeader
        title="Distribution"
        subtitle={`${totalCapacity} lead${totalCapacity === 1 ? '' : 's'} of capacity left across the team today`}
        action={isDefaultRules ? <Badge tone="neutral">default rules</Badge> : null}
      />
      <CardBody>
        <p className="text-muted mb-4 text-sm">
          Assigns enriched leads to owners by rule, giving each to whoever has the most headroom. Highest-priority leads
          are placed first, so if capacity runs out it is the weakest that wait.
        </p>

        <Button variant="primary" onClick={run} disabled={busy || totalCapacity === 0}>
          {busy ? 'Assigning…' : totalCapacity === 0 ? 'No capacity left today' : 'Run assignment'}
        </Button>

        {res ? (
          <p className={`mt-3 text-sm ${res.ok ? 'text-success' : 'text-danger'}`}>
            {res.message}
            {res.candidates !== undefined ? (
              <span className="text-muted"> ({res.candidates.toLocaleString()} considered)</span>
            ) : null}
          </p>
        ) : null}

        {team.length > 0 ? (
          <div className="mt-5 space-y-2">
            <p className="text-muted text-xs font-semibold uppercase tracking-wide">Team load today</p>
            {team.map((m) => (
              <div key={m.id} className="flex items-center gap-3">
                <span className="text-foreground w-40 shrink-0 truncate text-xs" title={m.name}>
                  {m.name}
                </span>
                <span className="text-subtle w-16 shrink-0 text-xs uppercase">{m.role}</span>
                <ProgressBar
                  value={m.assignedToday}
                  max={Math.max(1, m.dailyQuota)}
                  tone={m.assignedToday >= m.dailyQuota ? 'warning' : 'brand'}
                  className="flex-1"
                />
                <span className="text-muted w-28 shrink-0 text-right text-xs tabular-nums">
                  {m.assignedToday}/{m.dailyQuota} today
                </span>
                <span className="text-muted w-24 shrink-0 text-right text-xs tabular-nums">
                  {m.openLeads} open
                  {m.breached > 0 ? <span className="text-danger"> · {m.breached} late</span> : null}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted mt-4 text-sm">No active users can receive leads yet — add the team first.</p>
        )}
      </CardBody>
    </Card>
  );
}
