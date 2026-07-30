'use client';

import { useState } from 'react';
import { Bot } from 'lucide-react';
import { Button, Label, controlClass } from '@/components/ui';

/**
 * Starts a browser-based collector for a source that has no API here.
 *
 * The run itself happens in GitHub Actions, because a browser will not fit in
 * a serverless function. That is invisible from here on purpose — an operator
 * wants to collect from a source, not to know where the browser lives — but
 * the response links to the run so a failure is still findable.
 */
export default function CollectorButton({ slug, label }: { slug: string; label: string }) {
  const [details, setDetails] = useState(60);
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  async function start() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/sources/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, details, dryRun }),
      });
      const json = await res.json();
      setNote({ ok: json.ok !== false, text: json.message ?? `HTTP ${res.status}`, url: json.runsUrl });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-muted text-[11px]">
        {label} has no API key here, so a browser signs in and reads the saved searches. It runs on a build machine —
        a browser is far too large for this app&rsquo;s own functions — and posts what it finds back here.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <Label hint="each one is a page load">Open this many projects</Label>
          <select
            value={details}
            onChange={(e) => setDetails(Number(e.target.value))}
            className={`${controlClass} w-44`}
          >
            <option value={0}>None — list columns only</option>
            <option value={10}>10 — about 2 minutes</option>
            <option value={60}>60 — about 15 minutes</option>
            <option value={200}>200 — about 45 minutes</option>
          </select>
        </label>

        <label className="flex items-center gap-2 pb-2 text-[11px]">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          <span className="text-muted">Dry run — save nothing</span>
        </label>

        <Button onClick={start} disabled={busy} variant="primary" size="sm" className="flex items-center gap-1.5">
          <Bot size={12} strokeWidth={2.4} />
          {busy ? 'Starting…' : 'Collect now'}
        </Button>
      </div>

      {note ? (
        <p className={`text-[11px] ${note.ok ? 'text-success' : 'text-danger'}`}>
          {note.text}
          {note.url ? (
            <>
              {' '}
              <a href={note.url} target="_blank" rel="noreferrer" className="text-brand underline">
                Watch the run
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      <p className="text-subtle text-[11px]">
        Opening a project returns its full record — description, value range, coordinates — which the list view has no
        column for. More projects means a longer run, so start small.
      </p>
    </div>
  );
}
