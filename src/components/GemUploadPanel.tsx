'use client';

import { useCallback, useRef, useState } from 'react';
import GemResult, { type GemUploadResponse } from '@/components/gem/GemResult';

const KNOWN_TRACKERS = [
  'solar',
  'wind',
  'nuclear',
  'hydro',
  'geo',
  'bio',
  'coal_plant',
  'coal_mine',
  'coal_terminal',
  'oil_gas_plant',
  'oil_gas_extraction',
  'gas_pipeline',
  'oil_ngl_pipeline',
  'lng',
  'iron_ore_mine',
  'steel',
  'cement',
  'chemicals',
];

export default function GemUploadPanel({ dbReady }: { dbReady: boolean }) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<GemUploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const jsonFiles = Array.from(incoming).filter((f) => f.name.toLowerCase().endsWith('.json'));
    setError(
      jsonFiles.length < Array.from(incoming).length
        ? 'Only .json files are accepted; non-JSON files were skipped.'
        : null
    );
    setFiles((prev) => {
      const byName = new Map(prev.map((f) => [f.name, f]));
      for (const f of jsonFiles) byName.set(f.name, f);
      return Array.from(byName.values());
    });
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  function removeFile(name: string) {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  }

  async function upload() {
    if (files.length === 0) return;
    setBusy(true);
    setResponse(null);
    setError(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      const res = await fetch('/api/gem/ingest', { method: 'POST', body: fd });
      const json = (await res.json()) as GemUploadResponse;
      if (!res.ok || !json.ok) setError(json.message ?? `Upload failed (HTTP ${res.status}).`);
      setResponse(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border-base bg-surface p-5">
      {!dbReady ? (
        <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
          Supabase is not configured yet — uploads are parsed, normalized, and{' '}
          <strong>saved to the server folder</strong>, so they&rsquo;re immediately searchable under{' '}
          <strong>GEM Trackers</strong>. Once the database is set up, the same upload also persists to{' '}
          <code>canonical_projects</code>.
        </div>
      ) : null}

      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition ${
          dragging
            ? 'border-border-base bg-surface-raised'
            : 'border-border-base hover:border-border-base dark:hover:border-border-base'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
        <p className="text-sm font-medium text-foreground">
          Drag &amp; drop GEM tracker files here, or click to browse
        </p>
        <p className="mt-1 text-xs text-muted">
          One or more GEM JSON exports (solar, wind, nuclear, hydro, coal, oil &amp; gas, pipelines, mines, steel…). The
          tracker type is detected from each filename.
        </p>
      </div>

      {error ? <p className="mt-3 text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}

      {files.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            {files.length} file{files.length > 1 ? 's' : ''} queued
          </p>
          <ul className="mt-2 divide-y divide-border-base">
            {files.map((f) => {
              const tracker = f.name.replace(/\.[^.]+$/, '').toLowerCase();
              const known = KNOWN_TRACKERS.includes(tracker);
              return (
                <li key={f.name} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-foreground">
                    {f.name}
                    <span className="ml-2 text-xs text-muted">{(f.size / 1024).toFixed(0)} KB</span>
                    {!known ? (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                        unrecognized tracker
                      </span>
                    ) : null}
                  </span>
                  <button
                    onClick={() => removeFile(f.name)}
                    className="text-xs text-muted hover:text-red-600 dark:hover:text-red-400"
                  >
                    remove
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 flex gap-2">
            <button
              onClick={upload}
              disabled={busy}
              className="rounded bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-surface-raised disabled:opacity-50-raised"
            >
              {busy
                ? 'Processing…'
                : dbReady
                  ? `Ingest ${files.length} file${files.length > 1 ? 's' : ''} to DB`
                  : `Upload & save ${files.length} file${files.length > 1 ? 's' : ''}`}
            </button>
            <button
              onClick={() => {
                setFiles([]);
                setResponse(null);
                setError(null);
              }}
              disabled={busy}
              className="rounded border border-border-base px-4 py-2 text-sm font-medium text-muted hover:bg-surface-raised disabled:opacity-50-raised"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      {response ? <GemResult response={response} /> : null}
    </div>
  );
}
