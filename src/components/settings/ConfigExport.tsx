'use client';

import { useState } from 'react';
import { Download, Upload, AlertTriangle, Check } from 'lucide-react';
import { Button, Card, CardBody, CardHeader } from '@/components/ui';

/**
 * Downloads the workspace configuration.
 *
 * A plain link would be simpler, but the endpoint is permission-gated and a
 * failed download through an anchor is invisible — the browser navigates away
 * or silently saves an error page as .json. Fetching lets a refusal be said
 * out loud, and lets the summary below report what the file actually contains.
 */
interface SectionPlan {
  section: string;
  supported: boolean;
  summary: string;
  warnings: string[];
}

export default function ConfigExport() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [bundle, setBundle] = useState<{ name: string; data: unknown } | null>(null);
  const [plan, setPlan] = useState<{ ok: boolean; error?: string; sections: SectionPlan[]; warnings: string[] } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<{ ok: boolean; text: string } | null>(null);

  /** Dry run on selection. Nobody should have to press "preview" to be safe. */
  async function choose(file: File) {
    setPlan(null);
    setApplied(null);
    setBundle(null);
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      setPlan({ ok: false, error: 'That file is not valid JSON.', sections: [], warnings: [] });
      return;
    }
    setBundle({ name: file.name, data });
    setBusy(true);
    try {
      const res = await fetch('/api/config/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundle: data }),
      });
      setPlan(await res.json());
    } catch (e) {
      setPlan({ ok: false, error: e instanceof Error ? e.message : String(e), sections: [], warnings: [] });
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!bundle) return;
    setApplying(true);
    try {
      const res = await fetch('/api/config/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundle: bundle.data, apply: true }),
      });
      const json = await res.json();
      setApplied({ ok: json.ok !== false, text: json.message ?? `HTTP ${res.status}` });
      if (json.ok !== false) setPlan(null);
    } catch (e) {
      setApplied({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setApplying(false);
    }
  }

  async function download() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/config/export');

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setResult({ ok: false, text: body.message ?? `Export failed (HTTP ${res.status}).` });
        return;
      }

      const text = await res.text();
      const bundle = JSON.parse(text);

      const name =
        res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'source-hub-config.json';

      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);

      const sections = Object.entries(bundle.config ?? {}).filter(([, v]) =>
        Array.isArray(v) ? v.length > 0 : v && Object.keys(v as object).length > 0
      ).length;
      const sources = Object.keys(bundle.config?.sources ?? {}).length;

      // A partial export that looks complete is the failure mode worth naming.
      const missing: string[] = bundle.missing ?? [];
      setResult({
        ok: missing.length === 0,
        text:
          missing.length > 0
            ? `Saved ${name}, but these could not be read: ${missing.join(', ')}. The file is incomplete.`
            : `Saved ${name} — ${sections} section(s), ${sources} source(s).`,
      });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Current parameters"
        subtitle="Scoring, routing, enrichment, assignment, lead mix, schedules and saved queries — as one file"
      />
      <CardBody>
        <Button onClick={download} disabled={busy} variant="primary" className="flex items-center gap-2">
          <Download size={13} strokeWidth={2.4} />
          {busy ? 'Preparing…' : 'Download configuration'}
        </Button>

        {result ? (
          <p className={`mt-3 text-xs ${result.ok ? 'text-success' : 'text-danger'}`}>{result.text}</p>
        ) : null}

        <p className="text-subtle mt-3 max-w-2xl text-[11px]">
          No credentials are included — API keys stay encrypted in the database and are never gathered here, so this
          file can be committed, mailed or diffed safely. It also captures the three policies that have no screen yet
          (assignment rules, lead mix, prioritisation), which is currently the only way to read them.
        </p>

        <div className="border-border-base mt-6 border-t pt-5">
          <p className="text-foreground text-[13px] font-bold">Upload a configuration</p>
          <p className="text-muted mt-1 max-w-2xl text-xs">
            Applies assignment rules, territory routing, the lead mix and the roster. Any other section in the file is
            reported and left untouched. Nothing is written until you confirm.
          </p>

          <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border-strong bg-surface px-3 py-2 text-xs font-medium text-foreground hover:bg-surface-raised">
            <Upload size={13} strokeWidth={2.4} />
            {bundle ? bundle.name : 'Choose a JSON file'}
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Cleared so re-picking the same file after a fix still fires.
                e.target.value = '';
                if (f) choose(f);
              }}
            />
          </label>

          {busy && bundle ? <p className="text-muted mt-2 text-xs">Checking…</p> : null}

          {plan && !plan.ok ? (
            <p className="border-danger/30 bg-danger/5 text-danger mt-3 rounded-lg border px-3 py-2 text-xs">
              {plan.error}
            </p>
          ) : null}

          {plan?.ok ? (
            <div className="mt-3">
              <ul className="border-border-base divide-border-base divide-y rounded-lg border">
                {plan.sections.map((s) => (
                  <li key={s.section} className="px-3 py-2">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-foreground text-xs font-bold">{s.section}</span>
                      {s.supported ? null : <span className="text-subtle text-[10px] uppercase tracking-wide">skipped</span>}
                    </div>
                    <p className={`mt-0.5 text-[11px] ${s.supported ? 'text-body' : 'text-subtle'}`}>{s.summary}</p>
                    {s.warnings.map((w) => (
                      <p key={w} className="text-warning mt-1 flex items-start gap-1.5 text-[11px]">
                        <AlertTriangle size={11} strokeWidth={2.4} className="mt-0.5 shrink-0" />
                        {w}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>

              {plan.warnings.map((w) => (
                <p key={w} className="text-warning mt-2 flex items-start gap-1.5 text-[11px]">
                  <AlertTriangle size={11} strokeWidth={2.4} className="mt-0.5 shrink-0" />
                  {w}
                </p>
              ))}

              <Button onClick={apply} disabled={applying} variant="primary" size="sm" className="mt-3">
                {applying ? 'Applying…' : 'Apply this configuration'}
              </Button>
            </div>
          ) : null}

          {applied ? (
            <p className={`mt-3 flex items-start gap-1.5 text-xs ${applied.ok ? 'text-success' : 'text-danger'}`}>
              {applied.ok ? <Check size={12} strokeWidth={3} className="mt-0.5 shrink-0" /> : null}
              {applied.text}
            </p>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}
