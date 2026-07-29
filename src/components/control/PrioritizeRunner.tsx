'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardBody, Button, Badge, ProgressBar } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

interface RuleBreakdown {
  ruleId: string;
  ruleName: string;
  count: number;
  overflow: number;
}
interface PrioritizeResponse {
  ok: boolean;
  dryRun?: boolean;
  message: string;
  candidates?: number;
  selected?: number;
  deferred?: number;
  unmatched?: number;
  globalCap?: number | null;
  byRule?: RuleBreakdown[];
}

/**
 * Runs the daily selection pass. Preview first — this decides what money gets
 * spent on tomorrow, and the dry run costs nothing.
 */
export default function PrioritizeRunner({ isDefaultRules }: { isDefaultRules: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<'dry' | 'run' | null>(null);
  const [res, setRes] = useState<PrioritizeResponse | null>(null);

  async function run(dryRun: boolean) {
    setBusy(dryRun ? 'dry' : 'run');
    setRes(null);
    try {
      const r = await fetch('/api/prioritize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      });
      const json = (await r.json()) as PrioritizeResponse;
      setRes(json);
      toast.show(json.message, json.ok ? 'success' : 'error');
      if (json.ok && !dryRun) router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setRes({ ok: false, message });
      toast.show(message, 'error');
    } finally {
      setBusy(null);
    }
  }

  const maxRule = Math.max(1, ...(res?.byRule ?? []).map((r) => r.count + r.overflow));

  return (
    <Card>
      <CardHeader
        title="Daily prioritisation"
        subtitle="Selects which records are worth enriching, in rule order"
        action={isDefaultRules ? <Badge tone="neutral">default rules</Badge> : null}
      />
      <CardBody>
        <p className="text-muted mb-4 text-sm">
          Selection and enrichment are separate steps: this pass only moves records into the queue, so the list can be
          reviewed before any money is spent on it.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => run(true)} disabled={busy !== null}>
            {busy === 'dry' ? 'Checking…' : 'Preview selection'}
          </Button>
          <Button variant="primary" onClick={() => run(false)} disabled={busy !== null}>
            {busy === 'run' ? 'Queueing…' : 'Run prioritisation'}
          </Button>
        </div>

        {res ? (
          <div className="mt-4">
            <p className={`text-sm ${res.ok ? 'text-success' : 'text-danger'}`}>
              {res.dryRun ? 'Preview — nothing written. ' : ''}
              {res.message}
            </p>

            {res.candidates !== undefined ? (
              <div className="text-muted mt-2 flex flex-wrap gap-4 text-xs">
                <span>{res.candidates.toLocaleString()} considered</span>
                <span className="text-foreground">{(res.selected ?? 0).toLocaleString()} queued</span>
                <span>{(res.deferred ?? 0).toLocaleString()} deferred to tomorrow</span>
                <span>{(res.unmatched ?? 0).toLocaleString()} matched no rule</span>
                {res.globalCap != null ? <span>cap {res.globalCap.toLocaleString()}</span> : null}
              </div>
            ) : null}

            {res.byRule && res.byRule.length > 0 ? (
              <div className="mt-3 space-y-2">
                {res.byRule.map((r) => (
                  <div key={r.ruleId} className="flex items-center gap-3">
                    <span className="text-foreground w-56 shrink-0 truncate text-xs" title={r.ruleName}>
                      {r.ruleName}
                    </span>
                    <ProgressBar value={r.count} max={maxRule} className="flex-1" />
                    <span className="text-muted w-32 shrink-0 text-right text-xs tabular-nums">
                      {r.count}
                      {r.overflow > 0 ? <span className="text-subtle"> +{r.overflow} over</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
