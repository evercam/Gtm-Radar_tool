'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/lib/cn';
import { statusText } from '@/lib/status-colors';
import { useRouter } from 'next/navigation';

interface TestResponse {
  ok: boolean;
  configured: boolean;
  message: string;
  sample?: unknown[];
  normalizedSample?: unknown[];
  fieldsDetected?: string[];
  errorKind?: string;
}

function defaultSince(): string {
  const d = new Date(Date.now() - 180 * 86_400_000); // 180 days back — new-project feeds are often quiet day-to-day
  return d.toISOString().slice(0, 10);
}

/** `slug` is any live adapter slug — /api/ingest/[source]/test resolves it. */
export default function TestConnectionButton({ slug }: { slug: string }) {
  const [since, setSince] = useState(defaultSince());
  const [until, setUntil] = useState(new Date().toISOString().slice(0, 10));
  const [result, setResult] = useState<TestResponse | null>(null);
  const [showSample, setShowSample] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function run() {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/ingest/${slug}/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ since, until }),
        });
        const json = (await res.json()) as TestResponse;
        setResult(json);
      } catch (err) {
        setResult({ ok: false, configured: true, message: err instanceof Error ? err.message : String(err) });
      } finally {
        router.refresh(); // pick up last_tested_at / last_test_result written by the test route
      }
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1 text-xs">
        <input
          type="date"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          className="rounded border border-border-base bg-surface px-1.5 py-1 text-xs"
        />
        <span className="text-muted">to</span>
        <input
          type="date"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          className="rounded border border-border-base bg-surface px-1.5 py-1 text-xs"
        />
      </div>
      <button
        onClick={run}
        disabled={isPending}
        className="shrink-0 rounded border border-border-base px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-raised disabled:opacity-50-raised"
      >
        {isPending ? 'Testing…' : 'Test Connection'}
      </button>
      {result ? (
        <div className="max-w-xs">
          <span
            className={cn('text-xs', statusText[result.ok ? 'success' : 'danger'])}
          >
            {result.message}
          </span>
          {result.ok && result.sample && result.sample.length > 0 ? (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setShowSample((v) => !v)}
                className="text-[11px] font-medium text-muted underline hover:text-muted"
              >
                {showSample ? 'Hide' : 'Show'} sample ({result.sample.length} record
                {result.sample.length === 1 ? '' : 's'})
              </button>
              {showSample ? (
                <pre className="mt-1 max-h-64 overflow-auto rounded border border-border-base bg-surface-raised p-2 text-[10px] text-muted">
                  {JSON.stringify(result.normalizedSample ?? result.sample, null, 2)}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
