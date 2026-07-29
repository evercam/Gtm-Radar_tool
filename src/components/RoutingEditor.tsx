'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, Copy, Plus, RotateCcw, Trash2, GripVertical } from 'lucide-react';
import { DEFAULT_RULES, type RoutingRule, type RoutingMatch, type Route, type Stage } from '@/lib/routing';
import {
  BUSINESS_UNITS,
  BU_LABELS,
  ICP_LABELS,
  PRIORITY_BANDS,
  RECORD_TYPES,
  ROUTES,
  STAGES,
  VERTICALS,
  titleize,
} from '@/lib/semantics';
import { Badge, Button, Label, controlClass } from '@/components/ui';

export interface RoutingFacets {
  bu: string[];
  icp: string[];
  vertical: string[];
  recordType: string[];
  country: string[];
}

/** Union of what the classifier can produce and what the data actually holds. */
function options(known: readonly string[], present: string[]): string[] {
  return Array.from(new Set([...known, ...present])).sort((a, b) => a.localeCompare(b));
}

const SCORE_STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const SLA_CHOICES = [2, 4, 8, 12, 24, 48, 72];

const ROUTE_TONE: Record<Route, 'success' | 'warning' | 'info' | 'neutral'> = {
  sales: 'success',
  marketing: 'warning',
  partner: 'info',
  none: 'neutral',
};

/** A list-valued match key, rendered as toggle chips. */
function ChipPicker({
  label,
  hint,
  choices,
  selected,
  labelFor,
  onChange,
}: {
  label: string;
  hint?: string;
  choices: string[];
  selected: string[] | undefined;
  labelFor?: (v: string) => string;
  onChange: (next: string[] | undefined) => void;
}) {
  const active = selected ?? [];
  function toggle(v: string) {
    const next = active.includes(v) ? active.filter((x) => x !== v) : [...active, v];
    onChange(next.length ? next : undefined);
  }
  if (choices.length === 0) return null;
  return (
    <div>
      <Label hint={active.length === 0 ? 'any' : `${active.length} selected`}>{label}</Label>
      <div className="mt-1 flex flex-wrap gap-1">
        {choices.map((c) => {
          const on = active.includes(c);
          return (
            <button
              key={c}
              type="button"
              onClick={() => toggle(c)}
              aria-pressed={on}
              title={hint}
              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${
                on
                  ? 'border-brand bg-brand text-white'
                  : 'border-border-base text-muted hover:border-border-strong hover:text-foreground'
              }`}
            >
              {labelFor?.(c) ?? titleize(c)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A single-valued field rendered as a select, with "Any" as the empty state. */
function Choose({
  label,
  hint,
  value,
  onChange,
  children,
  width = 'w-36',
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  width?: string;
}) {
  return (
    <label className="block">
      <Label hint={hint}>{label}</Label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${controlClass} ${width}`}>
        {children}
      </select>
    </label>
  );
}

function numFromSelect(v: string): number | undefined {
  return v === '' ? undefined : Number(v);
}

/** Drop keys set back to "Any" so a saved rule carries no empty clauses. */
function setMatch(match: RoutingMatch, key: keyof RoutingMatch, value: unknown): RoutingMatch {
  const next = { ...match };
  if (value === undefined) delete next[key];
  else (next as Record<string, unknown>)[key] = value;
  return next;
}

function summarize(match: RoutingMatch): string {
  const bits: string[] = [];
  const list = (k: keyof RoutingMatch, name: string) => {
    const v = match[k] as string[] | undefined;
    if (v?.length) bits.push(`${name} ${v.map(titleize).join('/')}`);
  };
  list('priorityBands', 'band');
  list('record_type', 'type');
  list('bu', 'BU');
  list('icp', 'ICP');
  list('vertical', 'vertical');
  list('country', 'country');
  if (match.keyAccount !== undefined) bits.push(match.keyAccount ? 'key account' : 'not key account');
  if (match.contactStatus) bits.push(titleize(match.contactStatus).toLowerCase());
  if (match.minPriority !== undefined) bits.push(`priority ≥ ${match.minPriority}`);
  if (match.maxPriority !== undefined) bits.push(`priority ≤ ${match.maxPriority}`);
  if (match.minScore !== undefined) bits.push(`account score ≥ ${match.minScore}`);
  if (match.maxScore !== undefined) bits.push(`account score ≤ ${match.maxScore}`);
  if (match.minCompleteness !== undefined) bits.push(`completeness ≥ ${match.minCompleteness}%`);
  return bits.length ? bits.join(' · ') : 'matches every record';
}

/**
 * Rule builder for routing.
 *
 * This was a JSON textarea, which meant knowing the schema by heart and losing
 * the whole policy to one misplaced comma. Every clause is now picked from the
 * values that actually exist in the data, so a rule can only be built out of
 * things that can match.
 */
export default function RoutingEditor({
  initialRules,
  facets,
  countsByRule,
}: {
  initialRules: RoutingRule[];
  facets: RoutingFacets;
  countsByRule: Record<string, number>;
}) {
  const router = useRouter();
  const [rules, setRules] = useState<RoutingRule[]>(initialRules);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const dirty = JSON.stringify(rules) !== JSON.stringify(initialRules);

  const buChoices = options(BUSINESS_UNITS, facets.bu);
  const icpChoices = options(Object.keys(ICP_LABELS), facets.icp);
  const verticalChoices = options(VERTICALS, facets.vertical);
  const typeChoices = options(RECORD_TYPES, facets.recordType);

  function update(i: number, patch: Partial<RoutingRule>) {
    setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function patchMatch(i: number, key: keyof RoutingMatch, value: unknown) {
    setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, match: setMatch(r.match, key, value) } : r)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= rules.length) return;
    setRules((rs) => {
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setOpen((o) => (o === i ? j : o === j ? i : o));
  }
  function remove(i: number) {
    setRules((rs) => rs.filter((_, idx) => idx !== i));
    setOpen(null);
  }
  function duplicate(i: number) {
    setRules((rs) => [
      ...rs.slice(0, i + 1),
      { ...rs[i], name: `${rs[i].name} (copy)`, match: { ...rs[i].match }, assign: { ...rs[i].assign } },
      ...rs.slice(i + 1),
    ]);
    setOpen(i + 1);
  }
  function add() {
    setRules((rs) => [
      ...rs,
      { name: `Rule ${rs.length + 1}`, match: {}, assign: { route: 'sales', stage: 'qualify' } },
    ]);
    setOpen(rules.length);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/routing/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      });
      const json = await res.json();
      setMsg({ ok: json.ok, text: json.message });
      if (json.ok) router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-border-base bg-surface overflow-hidden rounded-2xl border">
      <div className="border-border-base flex flex-wrap items-center gap-3 border-b px-5 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-foreground text-[13px] font-bold">Rules</h3>
          <p className="text-muted text-[11px]">
            Evaluated top to bottom; the first match wins. Anything that falls through goes to marketing / nurture.
          </p>
        </div>
        <Button size="sm" onClick={add} className="flex items-center gap-1.5">
          <Plus size={12} strokeWidth={2.4} />
          Add rule
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setRules(DEFAULT_RULES.map((r) => ({ ...r, match: { ...r.match }, assign: { ...r.assign } })));
            setOpen(null);
          }}
          className="flex items-center gap-1.5"
        >
          <RotateCcw size={12} strokeWidth={2.2} />
          Defaults
        </Button>
      </div>

      <div>
        {rules.map((rule, i) => {
          const isOpen = open === i;
          const disabled = rule.enabled === false;
          const caught = countsByRule[rule.name];
          return (
            <div key={i} className="border-border-base border-b last:border-b-0">
              <div className={`flex flex-wrap items-center gap-2 px-4 py-2.5 ${disabled ? 'opacity-50' : ''}`}>
                <GripVertical size={12} className="text-subtle shrink-0" />
                <span className="text-subtle w-5 shrink-0 text-right text-[11px] tabular-nums">{i + 1}</span>

                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="min-w-0 flex-1 text-left"
                  aria-expanded={isOpen}
                >
                  <span className="text-foreground text-[12px] font-bold">{rule.name || 'Untitled rule'}</span>
                  <span className="text-muted block truncate text-[11px]">{summarize(rule.match)}</span>
                </button>

                {caught !== undefined ? (
                  <span className="text-subtle shrink-0 text-[10px] tabular-nums" title="records this rule catches">
                    {caught.toLocaleString()}
                  </span>
                ) : null}
                <Badge tone={ROUTE_TONE[rule.assign.route]}>
                  {rule.assign.route}/{rule.assign.stage}
                </Badge>

                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label="Move up"
                  className="text-subtle hover:text-foreground disabled:opacity-25"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === rules.length - 1}
                  aria-label="Move down"
                  className="text-subtle hover:text-foreground disabled:opacity-25"
                >
                  <ChevronDown size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => duplicate(i)}
                  aria-label="Duplicate rule"
                  className="text-subtle hover:text-foreground"
                >
                  <Copy size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  aria-label="Delete rule"
                  className="text-subtle hover:text-danger"
                >
                  <Trash2 size={12} />
                </button>
              </div>

              {isOpen ? (
                <div className="border-border-base bg-surface-raised animate-rise-in space-y-4 border-t px-5 py-4">
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="block min-w-56 flex-1">
                      <Label>Rule name</Label>
                      <input
                        value={rule.name}
                        onChange={(e) => update(i, { name: e.target.value })}
                        className={`${controlClass} w-full`}
                      />
                    </label>
                    <Choose
                      label="Status"
                      value={rule.enabled === false ? 'off' : 'on'}
                      onChange={(v) =>
                        setRules((rs) =>
                          rs.map((r, idx) => {
                            if (idx !== i) return r;
                            const next = { ...r };
                            if (v === 'on') delete next.enabled;
                            else next.enabled = false;
                            return next;
                          })
                        )
                      }
                      width="w-28"
                    >
                      <option value="on">Active</option>
                      <option value="off">Disabled</option>
                    </Choose>
                  </div>

                  <div>
                    <p className="text-muted mb-2 text-[10px] font-bold uppercase tracking-widest">
                      Match — leave a field on &ldquo;Any&rdquo; to ignore it
                    </p>
                    <div className="space-y-3">
                      <ChipPicker
                        label="Priority band"
                        choices={[...PRIORITY_BANDS]}
                        selected={rule.match.priorityBands}
                        labelFor={(v) => v}
                        onChange={(v) => patchMatch(i, 'priorityBands', v)}
                      />
                      <ChipPicker
                        label="Record type"
                        choices={typeChoices}
                        selected={rule.match.record_type}
                        onChange={(v) => patchMatch(i, 'record_type', v)}
                      />
                      <ChipPicker
                        label="Business unit"
                        choices={buChoices}
                        selected={rule.match.bu}
                        labelFor={(v) => BU_LABELS[v] ?? titleize(v)}
                        onChange={(v) => patchMatch(i, 'bu', v)}
                      />
                      <ChipPicker
                        label="ICP"
                        choices={icpChoices}
                        selected={rule.match.icp}
                        labelFor={(v) => ICP_LABELS[v] ?? titleize(v)}
                        onChange={(v) => patchMatch(i, 'icp', v)}
                      />
                      <ChipPicker
                        label="Vertical"
                        choices={verticalChoices}
                        selected={rule.match.vertical}
                        onChange={(v) => patchMatch(i, 'vertical', v)}
                      />
                      <ChipPicker
                        label="Country"
                        hint="values present in the data"
                        choices={facets.country}
                        selected={rule.match.country}
                        labelFor={(v) => v}
                        onChange={(v) => patchMatch(i, 'country', v)}
                      />
                    </div>

                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      <Choose
                        label="Key account"
                        value={rule.match.keyAccount === undefined ? '' : rule.match.keyAccount ? 'yes' : 'no'}
                        onChange={(v) => patchMatch(i, 'keyAccount', v === '' ? undefined : v === 'yes')}
                        width="w-40"
                      >
                        <option value="">Any</option>
                        <option value="yes">Key accounts only</option>
                        <option value="no">Exclude key accounts</option>
                      </Choose>
                      <Choose
                        label="Contact"
                        value={rule.match.contactStatus ?? ''}
                        onChange={(v) => patchMatch(i, 'contactStatus', v === '' ? undefined : v)}
                        width="w-40"
                      >
                        <option value="">Any</option>
                        <option value="has_contact">Has a contact</option>
                        <option value="needs_enrichment">Needs enrichment</option>
                      </Choose>
                      <Choose
                        label="Priority score"
                        hint="0–100"
                        value={rule.match.minPriority?.toString() ?? ''}
                        onChange={(v) => patchMatch(i, 'minPriority', numFromSelect(v))}
                        width="w-32"
                      >
                        <option value="">Any</option>
                        {SCORE_STEPS.map((n) => (
                          <option key={n} value={n}>
                            at least {n}
                          </option>
                        ))}
                      </Choose>
                      <Choose
                        label="Priority ceiling"
                        value={rule.match.maxPriority?.toString() ?? ''}
                        onChange={(v) => patchMatch(i, 'maxPriority', numFromSelect(v))}
                        width="w-36"
                      >
                        <option value="">no upper limit</option>
                        {SCORE_STEPS.map((n) => (
                          <option key={n} value={n}>
                            at most {n}
                          </option>
                        ))}
                      </Choose>
                      <Choose
                        label="Account score"
                        value={rule.match.minScore?.toString() ?? ''}
                        onChange={(v) => patchMatch(i, 'minScore', numFromSelect(v))}
                        width="w-32"
                      >
                        <option value="">Any</option>
                        {SCORE_STEPS.map((n) => (
                          <option key={n} value={n}>
                            at least {n}
                          </option>
                        ))}
                      </Choose>
                      <Choose
                        label="Completeness"
                        hint="% of critical fields"
                        value={rule.match.minCompleteness?.toString() ?? ''}
                        onChange={(v) => patchMatch(i, 'minCompleteness', numFromSelect(v))}
                        width="w-36"
                      >
                        <option value="">Any</option>
                        {SCORE_STEPS.map((n) => (
                          <option key={n} value={n}>
                            at least {n}%
                          </option>
                        ))}
                      </Choose>
                    </div>
                  </div>

                  <div>
                    <p className="text-muted mb-2 text-[10px] font-bold uppercase tracking-widest">Then assign</p>
                    <div className="flex flex-wrap items-end gap-3">
                      <Choose
                        label="Route"
                        value={rule.assign.route}
                        onChange={(v) => update(i, { assign: { ...rule.assign, route: v as Route } })}
                        width="w-32"
                      >
                        {ROUTES.map((r) => (
                          <option key={r} value={r}>
                            {titleize(r)}
                          </option>
                        ))}
                      </Choose>
                      <Choose
                        label="Stage"
                        value={rule.assign.stage}
                        onChange={(v) => update(i, { assign: { ...rule.assign, stage: v as Stage } })}
                        width="w-36"
                      >
                        {STAGES.map((s) => (
                          <option key={s} value={s}>
                            {titleize(s)}
                          </option>
                        ))}
                      </Choose>
                      <Choose
                        label="Team"
                        value={rule.assign.team ?? ''}
                        onChange={(v) => update(i, { assign: { ...rule.assign, team: v === '' ? undefined : v } })}
                        width="w-44"
                      >
                        <option value="">Unassigned</option>
                        <option value="$bu">The record&apos;s own BU</option>
                        {buChoices.map((b) => (
                          <option key={b} value={b}>
                            {BU_LABELS[b] ?? titleize(b)}
                          </option>
                        ))}
                      </Choose>
                      <Choose
                        label="SLA"
                        hint="time to first touch"
                        value={rule.assign.sla_hours?.toString() ?? ''}
                        onChange={(v) => update(i, { assign: { ...rule.assign, sla_hours: numFromSelect(v) } })}
                        width="w-32"
                      >
                        <option value="">No SLA</option>
                        {SLA_CHOICES.map((h) => (
                          <option key={h} value={h}>
                            {h} hours
                          </option>
                        ))}
                      </Choose>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}

        <div className="text-muted flex items-center gap-2 px-4 py-2.5 text-[11px] italic">
          <span className="text-subtle w-5 shrink-0 text-right">·</span>
          Everything else
          <Badge tone="warning">marketing/nurture</Badge>
        </div>
      </div>

      <div className="border-border-base flex flex-wrap items-center gap-3 border-t px-5 py-3">
        <Button variant="primary" size="sm" onClick={save} disabled={busy || !dirty}>
          {busy ? 'Saving…' : dirty ? 'Save rules & re-preview' : 'Saved'}
        </Button>
        {dirty ? (
          <Button size="sm" variant="ghost" onClick={() => setRules(initialRules)}>
            Discard changes
          </Button>
        ) : null}
        {msg ? <span className={`text-[11px] ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</span> : null}
        <span className="text-subtle ml-auto text-[10px]">
          {rules.length} rule{rules.length === 1 ? '' : 's'}
          {dirty ? ' · counts above are stale until you save' : ''}
        </span>
      </div>
    </div>
  );
}
