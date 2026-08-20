'use client';

import { useCallback, useRef, useState } from 'react';

interface FileResult {
  file: string;
  parsed: number;
  normalized: number;
  failed: number;
  error?: string;
}
interface ImportResponse {
  ok: boolean;
  persisted?: boolean;
  message?: string;
  totals?: { normalized: number; inserted: number; updated: number };
  files?: FileResult[];
  sample?: Array<Record<string, unknown>>;
}

export default function KeyAccountImportPanel({ dbReady }: { dbReady: boolean }) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const add = useCallback((incoming: FileList | File[]) => {
    const csv = Array.from(incoming).filter((f) => /\.csv$/i.test(f.name));
    setError(
      csv.length < Array.from(incoming).length ? 'Only .csv files are accepted (export your Excel sheet as CSV).' : null
    );
    setFiles((prev) => {
      const byName = new Map(prev.map((f) => [f.name, f]));
      for (const f of csv) byName.set(f.name, f);
      return Array.from(byName.values());
    });
  }, []);

  async function upload() {
    if (!files.length) return;
    setBusy(true);
    setRes(null);
    setError(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      const r = await fetch('/api/import/keyaccounts', { method: 'POST', body: fd });
      const json = (await r.json()) as ImportResponse;
      if (!r.ok || !json.ok) setError(json.message ?? `Import failed (HTTP ${r.status}).`);
      setRes(json);
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
          Supabase not configured — imports are parsed and previewed but not saved. Once the DB is up, the same import
          persists to <code>canonical_projects</code> as <code>account</code> records.
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
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files?.length) add(e.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition ${
          dragging
            ? 'border-border-base bg-surface-raised'
            : 'border-border-base hover:border-border-base dark:hover:border-border-base'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && add(e.target.files)}
        />
        <p className="text-sm font-medium text-foreground">Drop key-account CSV files here, or click to browse</p>
        <p className="mt-1 text-xs text-muted">
          Columns are matched flexibly — e.g.{' '}
          <em>Account/Company, Website, Country, Portfolio value, Contact, Email, Sector</em>. Export an Excel sheet as
          CSV.
        </p>
      </div>

      {error ? <p className="mt-3 text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}

      {files.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{files.length} file(s)</p>
          <ul className="mt-1 text-sm text-muted">
            {files.map((f) => (
              <li key={f.name}>
                {f.name} <span className="text-xs text-muted">{(f.size / 1024).toFixed(0)} KB</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <button
              onClick={upload}
              disabled={busy}
              className="rounded bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-surface-raised disabled:opacity-50-raised"
            >
              {busy ? 'Importing…' : dbReady ? 'Import to DB' : 'Parse & preview'}
            </button>
            <button
              onClick={() => {
                setFiles([]);
                setRes(null);
              }}
              disabled={busy}
              className="rounded border border-border-base px-4 py-2 text-sm font-medium text-muted hover:bg-surface-raised disabled:opacity-50-raised"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      {res ? (
        <div className="mt-5 border-t border-border-base pt-4">
          <p className="text-sm font-medium text-foreground">{res.message}</p>
          {res.files?.length ? (
            <ul className="mt-2 text-xs text-muted">
              {res.files.map((f) => (
                <li key={f.file}>
                  <span className="font-medium text-foreground">{f.file}</span>: parsed {f.parsed}, imported{' '}
                  {f.normalized}
                  {f.failed ? `, skipped ${f.failed}` : ''}
                  {f.error ? <span className="text-rose-600 dark:text-rose-400"> — {f.error}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {res.sample?.length ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">
                Normalized sample ({res.sample.length})
              </summary>
              <pre className="mt-1 max-h-80 overflow-auto rounded bg-surface-raised p-2 text-xs text-muted">
                {JSON.stringify(res.sample, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
