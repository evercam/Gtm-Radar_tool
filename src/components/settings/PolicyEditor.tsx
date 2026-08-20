'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Generic editor for the admin-parameterized policies (scoring, enrichment).
 *
 * Renders the parameters people actually tune as real inputs, and keeps a raw
 * JSON escape hatch for the deeper structures (the phase-timing table, the
 * record-type fallbacks) so nothing is locked away behind the form. Both write
 * through the same validated endpoint, so an invalid edit comes back with a
 * reason instead of silently landing.
 */

export type FieldKind = 'number' | 'toggle' | 'list' | 'select' | 'multiselect';

export interface Choice {
  value: string;
  label: string;
}

export interface PolicyField {
  /** Dot path into the config, e.g. "weights.timing" or "engines.apollo". */
  path: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Grouping header this field sits under. */
  group: string;
  /** Options for select / multiselect. */
  choices?: Choice[];
  /** What an empty multiselect means, e.g. "all business units". */
  emptyLabel?: string;
  /** Render across the full row — for long option lists. */
  wide?: boolean;
}

type Config = Record<string, unknown>;

function getPath(obj: Config, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Config)[k] : undefined), obj);
}

function setPath(obj: Config, path: string, value: unknown): Config {
  const keys = path.split('.');
  const next: Config = { ...obj };
  let cursor: Config = next;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    cursor[k] = { ...((cursor[k] as Config) ?? {}) };
    cursor = cursor[k] as Config;
  }
  cursor[keys[keys.length - 1]] = value;
  return next;
}

export default function PolicyEditor({
  policyName,
  initialConfig,
  defaults,
  fields,
  isDefault,
  advancedHint,
  help,
}: {
  /** Endpoint segment: "scoring" | "enrichment". */
  policyName: string;
  initialConfig: Config;
  defaults: Config;
  fields: PolicyField[];
  isDefault: boolean;
  advancedHint: string;
  /** Explains what the section does. Collapsed by default — read once, then in the way. */
  help?: { title: string; body: React.ReactNode };
}) {
  const router = useRouter();
  const [config, setConfig] = useState<Config>(initialConfig);
  const [advanced, setAdvanced] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [json, setJson] = useState(() => JSON.stringify(initialConfig, null, 2));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const groups = Array.from(new Set(fields.map((f) => f.group)));

  function update(path: string, value: unknown) {
    setConfig((c) => {
      const next = setPath(c, path, value);
      setJson(JSON.stringify(next, null, 2));
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setMsg(null);

    // The JSON pane is authoritative when it's open — it can express things the
    // form can't, and silently discarding those edits would be worse than
    // failing loudly on a syntax error.
    let payload: unknown = config;
    if (advanced) {
      try {
        payload = JSON.parse(json);
      } catch (e) {
        setBusy(false);
        setMsg({ ok: false, text: `JSON error: ${e instanceof Error ? e.message : String(e)}` });
        return;
      }
    }

    try {
      const res = await fetch(`/api/policy/${policyName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: payload }),
      });
      const j = await res.json();
      setMsg({ ok: j.ok, text: j.message });
      if (j.ok) {
        setConfig(payload as Config);
        router.refresh();
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setConfig(defaults);
    setJson(JSON.stringify(defaults, null, 2));
    setMsg(null);
  }

  const input = 'mt-1 block w-full rounded border border-border-base bg-surface px-2 py-1.5 text-sm text-foreground';

  /** Toggle one value in a multiselect, keeping the stored order stable. */
  function toggleIn(path: string, value: string, current: unknown) {
    const list = Array.isArray(current) ? (current as string[]) : [];
    update(path, list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  return (
    <div className="rounded-lg border border-border-base bg-surface p-5">
      {help ? (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setShowHelp((v) => !v)}
            aria-expanded={showHelp}
            className="text-muted hover:text-foreground text-[11px] font-semibold underline underline-offset-2"
          >
            {showHelp ? 'Hide' : 'How does this work?'}
          </button>
          {showHelp ? (
            <div className="border-border-base bg-surface-raised text-body animate-rise-in mt-2 rounded-lg border px-4 py-3 text-[11px] leading-relaxed">
              <p className="text-foreground mb-1.5 text-[12px] font-bold">{help.title}</p>
              {help.body}
            </div>
          ) : null}
        </div>
      ) : null}

      {isDefault ? (
        <p className="mb-4 rounded bg-surface-raised px-3 py-2 text-xs text-muted/50">
          Nothing saved yet — these are the built-in defaults. Saving writes them to the database, where they take
          effect immediately on the next run.
        </p>
      ) : null}

      {!advanced ? (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group}>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{group}</h4>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {fields
                  .filter((f) => f.group === group)
                  .map((f) => {
                    const value = getPath(config, f.path);
                    return (
                      <label
                        key={f.path}
                        className={`text-muted text-xs font-medium ${f.wide ? 'sm:col-span-2 lg:col-span-3' : ''}`}
                      >
                        <span className="flex items-center gap-2">
                          {f.label}
                          {f.kind === 'toggle' ? (
                            <input
                              type="checkbox"
                              checked={Boolean(value)}
                              onChange={(e) => update(f.path, e.target.checked)}
                              className="h-4 w-4 rounded border-border-base"
                            />
                          ) : null}
                        </span>
                        {f.kind === 'number' ? (
                          <input
                            type="number"
                            value={typeof value === 'number' ? value : ''}
                            min={f.min}
                            max={f.max}
                            step={f.step ?? 1}
                            onChange={(e) => update(f.path, e.target.value === '' ? 0 : Number(e.target.value))}
                            className={input}
                          />
                        ) : null}
                        {f.kind === 'select' ? (
                          <select
                            value={typeof value === 'string' ? value : ''}
                            onChange={(e) => update(f.path, e.target.value)}
                            className={input}
                          >
                            {(f.choices ?? []).map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        {f.kind === 'multiselect' ? (
                          <span className="mt-1.5 flex flex-wrap gap-1">
                            {(f.choices ?? []).map((c) => {
                              const list = Array.isArray(value) ? (value as string[]) : [];
                              const on = list.includes(c.value);
                              return (
                                <button
                                  key={c.value}
                                  type="button"
                                  onClick={() => toggleIn(f.path, c.value, value)}
                                  aria-pressed={on}
                                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                                    on
                                      ? 'border-brand bg-brand text-white'
                                      : 'border-border-base text-muted hover:border-border-strong hover:text-foreground'
                                  }`}
                                >
                                  {c.label}
                                </button>
                              );
                            })}
                          </span>
                        ) : null}
                        {f.kind === 'list' ? (
                          <input
                            type="text"
                            value={Array.isArray(value) ? (value as string[]).join(', ') : ''}
                            onChange={(e) =>
                              update(
                                f.path,
                                e.target.value
                                  .split(',')
                                  .map((s) => s.trim())
                                  .filter(Boolean)
                              )
                            }
                            className={input}
                          />
                        ) : null}
                        {f.kind === 'multiselect' && f.emptyLabel && (!Array.isArray(value) || value.length === 0) ? (
                          <span className="text-subtle mt-1 block text-[11px] font-normal italic">
                            None selected — {f.emptyLabel}.
                          </span>
                        ) : null}
                        {f.hint ? (
                          <span className="text-muted mt-0.5 block text-[11px] font-normal">{f.hint}</span>
                        ) : null}
                      </label>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div>
          <p className="mb-2 text-xs text-muted">{advancedHint}</p>
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            spellCheck={false}
            className="h-96 w-full rounded border border-border-base bg-surface-raised p-2 font-mono text-xs text-foreground"
          />
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={save}
          disabled={busy}
          className="rounded bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-surface-raised disabled:opacity-50-raised"
        >
          {busy ? 'Saving…' : 'Save parameters'}
        </button>
        <button onClick={() => setAdvanced((v) => !v)} className="text-xs text-muted underline hover:text-foreground">
          {advanced ? 'Back to form' : 'Edit as JSON'}
        </button>
        <button onClick={reset} className="text-xs text-muted underline hover:text-foreground">
          Reset to defaults
        </button>
        {msg ? (
          <span
            className={`text-xs ${msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
          >
            {msg.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
