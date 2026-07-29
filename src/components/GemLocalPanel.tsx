'use client';

import { useState } from 'react';
import GemResult, { type GemUploadResponse } from '@/components/gem/GemResult';

interface LocalFile {
  name: string;
  sizeBytes: number;
  tracker: string;
  trackerLabel: string;
}

interface ListResponse {
  ok: boolean;
  dir: string;
  files: LocalFile[];
  message?: string;
}

export interface GemLocalPanelProps {
  initialDir: string;
  initialFiles: LocalFile[];
  initialMessage?: string | null;
}

/**
 * Ingest GEM files straight from the server's configured folder (GEM_DATA_DIR)
 * — no dragging required. The initial listing is fetched server-side and passed
 * in as props; Refresh re-lists via the API. Selecting files and ingesting runs
 * the ingestion server-side.
 */
export default function GemLocalPanel({ initialDir, initialFiles, initialMessage }: GemLocalPanelProps) {
  const [dir, setDir] = useState<string>(initialDir);
  const [files, setFiles] = useState<LocalFile[]>(initialFiles);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialFiles.map((f) => f.name)));
  const [listMsg, setListMsg] = useState<string | null>(initialMessage ?? null);
  const [loadingList, setLoadingList] = useState(false);
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<GemUploadResponse | null>(null);

  async function refresh() {
    setLoadingList(true);
    setListMsg(null);
    try {
      const res = await fetch('/api/gem/local');
      const json = (await res.json()) as ListResponse;
      setDir(json.dir ?? '');
      setFiles(json.files ?? []);
      setSelected(new Set((json.files ?? []).map((f) => f.name)));
      setListMsg(
        !json.ok || (json.files ?? []).length === 0
          ? (json.message ?? 'No GEM files found in the server folder.')
          : null
      );
    } catch (err) {
      setListMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingList(false);
    }
  }

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function ingest() {
    setBusy(true);
    setResponse(null);
    try {
      const res = await fetch('/api/gem/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: Array.from(selected) }),
      });
      setResponse((await res.json()) as GemUploadResponse);
    } catch (err) {
      setResponse({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const allSelected = files.length > 0 && selected.size === files.length;

  return (
    <div className="rounded-lg border border-border-base bg-surface p-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">Load from server folder</h3>
          {dir ? <p className="mt-0.5 text-xs text-muted">{dir}</p> : null}
        </div>
        <button
          onClick={refresh}
          disabled={loadingList}
          className="rounded border border-border-base px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-raised disabled:opacity-50-raised"
        >
          {loadingList ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {listMsg ? (
        <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
          {listMsg} Set <code>GEM_DATA_DIR</code> in <code>.env.local</code> to point at your GEM export folder.
        </p>
      ) : null}

      {files.length > 0 ? (
        <>
          <div className="mt-3 flex items-center justify-between">
            <button
              onClick={() => setSelected(allSelected ? new Set() : new Set(files.map((f) => f.name)))}
              className="text-xs font-medium text-muted hover:text-foreground"
            >
              {allSelected ? 'Deselect all' : 'Select all'}
            </button>
            <span className="text-xs text-muted">
              {selected.size} of {files.length} selected
            </span>
          </div>

          <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
            {files.map((f) => (
              <li key={f.name}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface-raised">
                  <input
                    type="checkbox"
                    checked={selected.has(f.name)}
                    onChange={() => toggle(f.name)}
                    className="accent-zinc-900 dark:accent-zinc-100"
                  />
                  <span className="text-foreground">{f.trackerLabel}</span>
                  <span className="ml-auto text-xs text-muted">{(f.sizeBytes / 1024).toFixed(0)} KB</span>
                </label>
              </li>
            ))}
          </ul>

          <button
            onClick={ingest}
            disabled={busy || selected.size === 0}
            className="mt-4 rounded bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-surface-raised disabled:opacity-50-raised"
          >
            {busy ? 'Processing…' : `Ingest ${selected.size} file${selected.size === 1 ? '' : 's'} from server`}
          </button>
        </>
      ) : null}

      {response ? <GemResult response={response} /> : null}
    </div>
  );
}
