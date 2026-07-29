'use client';

export interface GemFileResult {
  file: string;
  tracker: string;
  trackerLabel: string;
  parsed: number;
  normalized: number;
  failed: number;
  inserted?: number;
  updated?: number;
  error?: string;
}

export interface GemUploadResponse {
  ok: boolean;
  persisted?: boolean;
  message?: string;
  dir?: string;
  totals?: { normalized: number; inserted: number; updated: number };
  files?: GemFileResult[];
  sample?: Array<Record<string, unknown>>;
}

/** Shared results view for both the drag-and-drop and server-folder panels. */
export default function GemResult({ response }: { response: GemUploadResponse }) {
  return (
    <div className="mt-5 border-t border-border-base pt-4">
      <p className="text-sm font-medium text-foreground">{response.message}</p>

      {response.files && response.files.length > 0 ? (
        <div className="mt-3 overflow-x-auto rounded border border-border-base">
          <table className="w-full text-left text-xs">
            <thead className="bg-surface-raised uppercase text-muted">
              <tr>
                <th className="px-3 py-1.5">File</th>
                <th className="px-3 py-1.5">Tracker</th>
                <th className="px-3 py-1.5">Parsed</th>
                <th className="px-3 py-1.5">Normalized</th>
                <th className="px-3 py-1.5">Failed</th>
                {response.persisted ? <th className="px-3 py-1.5">Inserted</th> : null}
                {response.persisted ? <th className="px-3 py-1.5">Updated</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-base">
              {response.files.map((r) => (
                <tr key={r.file}>
                  <td className="px-3 py-1.5 font-medium text-foreground">{r.file}</td>
                  <td className="px-3 py-1.5 text-muted">{r.trackerLabel}</td>
                  <td className="px-3 py-1.5 text-muted">{r.parsed}</td>
                  <td className="px-3 py-1.5 text-muted">{r.normalized}</td>
                  <td className="px-3 py-1.5 text-muted">{r.failed}</td>
                  {response.persisted ? (
                    <td className="px-3 py-1.5 text-emerald-600 dark:text-emerald-400">{r.inserted ?? '—'}</td>
                  ) : null}
                  {response.persisted ? <td className="px-3 py-1.5 text-muted">{r.updated ?? '—'}</td> : null}
                  {r.error ? (
                    <td className="px-3 py-1.5 text-red-600 dark:text-red-400" colSpan={2}>
                      {r.error}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {response.sample && response.sample.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">
            Normalized sample ({response.sample.length})
          </summary>
          <pre className="mt-1 max-h-80 overflow-auto rounded bg-surface-raised p-2 text-xs text-muted">
            {JSON.stringify(response.sample, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
