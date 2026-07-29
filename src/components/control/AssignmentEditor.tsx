'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, Copy, Plus, RotateCcw, Trash2, GripVertical } from 'lucide-react';
import { DEFAULT_ASSIGNMENT_RULES, type AssignmentRule, type AssignmentConditions } from '@/lib/assignment';
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
import { ROLE_LABELS, type Role } from '@/lib/auth/roles';
import { Badge, Button, Label, controlClass } from '@/components/ui';

/** Rules store a plain string, so look the label up defensively. */
const roleLabel = (r: string | null | undefined): string =>
  (r ? (ROLE_LABELS[r as Role] ?? titleize(r)) : '');

export interface AssignmentTarget {
  id: string;
  name: string;
  role: string;
  bu: string[];
  verticals: string[];
  regions: string[];
  isActive: boolean;
}

const SCORE_STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const VALUE_STEPS = [0, 1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000];
const RECEIVING_ROLES = ['bdr', 'sdr', 'ae', 'marketing'];

function money(n: number): string {
  if (n === 0) return 'Any value';
  if (n >= 1e6) return `at least $${n / 1e6}M`;
  return `at least $${n.toLocaleString()}`;
}

/** A list-valued condition as toggle chips. */
function ChipPicker({
  label,
  choices,
  selected,
  labelFor,
  emptyLabel,
  onChange,
}: {
  label: string;
  choices: string[];
  selected: string[] | undefined;
  labelFor?: (v: string) => string;
  emptyLabel: string;
  onChange: (next: string[] | undefined) => void;
}) {
  const active = selected ?? [];
  if (choices.length === 0) return null;
  return (
    <div>
      <Label hint={active.length === 0 ? emptyLabel : `${active.length} selected`}>{label}</Label>
      <div className="mt-1 flex flex-wrap gap-1">
        {choices.map((c) => {
          const on = active.includes(c);
          return (
            <button
              key={c}
              type="button"
              aria-pressed={on}
              onClick={() => {
                const next = on ? active.filter((x) => x !== c) : [...active, c];
                onChange(next.length ? next : undefined);
              }}
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

function setCond(c: AssignmentConditions, key: keyof AssignmentConditions, value: unknown): AssignmentConditions {
  const next = { ...c };
  if (value === undefined) delete next[key];
  else (next as Record<string, unknown>)[key] = value;
  return next;
}

function summarize(c: AssignmentConditions): string {
  const bits: string[] = [];
  const list = (k: keyof AssignmentConditions, name: string) => {
    const v = c[k] as string[] | undefined;
    if (v?.length) bits.push(`${name} ${v.map(titleize).join('/')}`);
  };
  list('stage', 'stage');
  list('route', 'route');
  list('bands', 'band');
  list('bu', 'BU');
  list('vertical', 'vertical');
  list('icp', 'ICP');
  list('recordTypes', 'type');
  list('region', 'region');
  if (c.requiresContact) bits.push('has a contact');
  if (c.minPriorityScore !== undefined) bits.push(`score ≥ ${c.minPriorityScore}`);
  if (c.minValue) bits.push(money(c.minValue));
  return bits.length ? bits.join(' · ') : 'every unassigned lead';
}

/**
 * Who owns a lead.
 *
 * These rules existed with no UI at all — the only way to change them was to
 * hand-write JSON and POST it, so nobody ever did, and every lead stayed
 * unowned. Assignment is the last step of the journey here: a lead is finished
 * when it has been enriched and given to a person.
 *
 * Targeting a ROLE rather than a person is the default on purpose. Within a
 * role the engine gives the lead to whoever is furthest below their daily
 * quota, so work spreads instead of piling on whoever sorts first; naming a
 * person opts out of that.
 */
export default function AssignmentEditor({
  initialRules,
  isDefault,
  users,
  unassigned,
}: {
  initialRules: AssignmentRule[];
  isDefault: boolean;
  users: AssignmentTarget[];
  unassigned: number;
}) {
  const router = useRouter();
  const [rules, setRules] = useState<AssignmentRule[]>(initialRules);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const dirty = JSON.stringify(rules) !== JSON.stringify(initialRules);
  const active = users.filter((u) => u.isActive);

  /** Roles with nobody active to receive — a rule targeting one can never assign. */
  const staffedRoles = new Set(active.map((u) => u.role));

  function update(i: number, patch: Partial<AssignmentRule>) {
    setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function patchCond(i: number, key: keyof AssignmentConditions, value: unknown) {
    setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, conditions: setCond(r.conditions, key, value) } : r)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= rules.length) return;
    setRules((rs) => {
      const next = [...rs];
      [next[i], next[j]] = [next[j], next[i]];
      return next.map((r, idx) => ({ ...r, priority: idx + 1 }));
    });
    setOpen((o) => (o === i ? j : o === j ? i : o));
  }
  function remove(i: number) {
    setRules((rs) => rs.filter((_, idx) => idx !== i).map((r, idx) => ({ ...r, priority: idx + 1 })));
    setOpen(null);
  }
  function duplicate(i: number) {
    setRules((rs) => {
      const copy = {
        ...rs[i],
        id: `${rs[i].id}_copy_${Date.now().toString(36)}`,
        name: `${rs[i].name} (copy)`,
        conditions: { ...rs[i].conditions },
      };
      return [...rs.slice(0, i + 1), copy, ...rs.slice(i + 1)].map((r, idx) => ({ ...r, priority: idx + 1 }));
    });
    setOpen(i + 1);
  }
  function add() {
    setRules((rs) => [
      ...rs,
      {
        id: `rule_${Date.now().toString(36)}`,
        name: `Rule ${rs.length + 1}`,
        priority: rs.length + 1,
        enabled: true,
        conditions: {},
        toRole: 'bdr',
        toUserId: null,
      },
    ]);
    setOpen(rules.length);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'saveRules', rules }),
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
          <h3 className="text-foreground text-[13px] font-bold">
            Assignment rules{isDefault ? <span className="text-muted ml-2 font-normal">(built-in defaults)</span> : null}
          </h3>
          <p className="text-muted text-[11px]">
            Evaluated top to bottom; the first match wins. Within a role the lead goes to whoever is furthest below
            their daily quota.
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
            setRules(DEFAULT_ASSIGNMENT_RULES.map((r) => ({ ...r, conditions: { ...r.conditions } })));
            setOpen(null);
          }}
          className="flex items-center gap-1.5"
        >
          <RotateCcw size={12} strokeWidth={2.2} />
          Defaults
        </Button>
      </div>

      {active.length === 0 ? (
        <div className="border-warning/40 bg-warning/10 text-warning border-b px-5 py-3 text-[11px]">
          <strong>Nobody can receive a lead yet.</strong> Every rule below will match and then find no one to assign to.
          Add people and set their scope first — {unassigned.toLocaleString()} leads are waiting.
        </div>
      ) : null}

      <div>
        {rules.map((rule, i) => {
          const isOpen = open === i;
          const disabled = rule.enabled === false;
          const target = rule.toUserId
            ? (users.find((u) => u.id === rule.toUserId)?.name ?? 'unknown user')
            : (roleLabel(rule.toRole) || 'nobody');
          // A rule pointed at an empty role looks configured but can never fire.
          const unstaffed = !rule.toUserId && rule.toRole ? !staffedRoles.has(rule.toRole) : false;

          return (
            <div key={rule.id} className="border-border-base border-b last:border-b-0">
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
                  <span className="text-muted block truncate text-[11px]">{summarize(rule.conditions)}</span>
                </button>

                {unstaffed ? <Badge tone="warning">nobody in this role</Badge> : null}
                <Badge tone={rule.toUserId ? 'info' : 'success'}>→ {target}</Badge>

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
                      onChange={(v) => update(i, { enabled: v === 'on' })}
                      width="w-28"
                    >
                      <option value="on">Active</option>
                      <option value="off">Disabled</option>
                    </Choose>
                  </div>

                  <div>
                    <p className="text-muted mb-2 text-[10px] font-bold uppercase tracking-widest">
                      Match — leave a field empty to ignore it
                    </p>
                    <div className="space-y-3">
                      <ChipPicker
                        label="Stage"
                        choices={[...STAGES]}
                        selected={rule.conditions.stage}
                        emptyLabel="any stage"
                        onChange={(v) => patchCond(i, 'stage', v)}
                      />
                      <ChipPicker
                        label="Route"
                        choices={[...ROUTES]}
                        selected={rule.conditions.route}
                        emptyLabel="any route"
                        onChange={(v) => patchCond(i, 'route', v)}
                      />
                      <ChipPicker
                        label="Priority band"
                        choices={[...PRIORITY_BANDS]}
                        selected={rule.conditions.bands}
                        labelFor={(v) => v}
                        emptyLabel="any band"
                        onChange={(v) => patchCond(i, 'bands', v)}
                      />
                      <ChipPicker
                        label="Business unit"
                        choices={[...BUSINESS_UNITS]}
                        selected={rule.conditions.bu}
                        labelFor={(v) => BU_LABELS[v] ?? titleize(v)}
                        emptyLabel="any BU"
                        onChange={(v) => patchCond(i, 'bu', v)}
                      />
                      <ChipPicker
                        label="Vertical"
                        choices={[...VERTICALS]}
                        selected={rule.conditions.vertical}
                        emptyLabel="any vertical"
                        onChange={(v) => patchCond(i, 'vertical', v)}
                      />
                      <ChipPicker
                        label="ICP"
                        choices={Object.keys(ICP_LABELS)}
                        selected={rule.conditions.icp}
                        labelFor={(v) => ICP_LABELS[v] ?? titleize(v)}
                        emptyLabel="any ICP"
                        onChange={(v) => patchCond(i, 'icp', v)}
                      />
                      <ChipPicker
                        label="Record type"
                        choices={[...RECORD_TYPES]}
                        selected={rule.conditions.recordTypes}
                        emptyLabel="any type"
                        onChange={(v) => patchCond(i, 'recordTypes', v)}
                      />
                    </div>

                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      <Choose
                        label="Contact"
                        value={rule.conditions.requiresContact ? 'yes' : ''}
                        onChange={(v) => patchCond(i, 'requiresContact', v === 'yes' ? true : undefined)}
                        width="w-44"
                      >
                        <option value="">Any</option>
                        <option value="yes">Must have a contact</option>
                      </Choose>
                      <Choose
                        label="Priority score"
                        value={rule.conditions.minPriorityScore?.toString() ?? ''}
                        onChange={(v) => patchCond(i, 'minPriorityScore', v === '' ? undefined : Number(v))}
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
                        label="Project value"
                        value={rule.conditions.minValue?.toString() ?? ''}
                        onChange={(v) => patchCond(i, 'minValue', v === '' ? undefined : Number(v))}
                        width="w-40"
                      >
                        <option value="">Any</option>
                        {VALUE_STEPS.filter((v) => v > 0).map((n) => (
                          <option key={n} value={n}>
                            {money(n)}
                          </option>
                        ))}
                      </Choose>
                    </div>
                  </div>

                  <div>
                    <p className="text-muted mb-2 text-[10px] font-bold uppercase tracking-widest">Then give it to</p>
                    <div className="flex flex-wrap items-end gap-3">
                      <Choose
                        label="Target"
                        hint="a role spreads by quota"
                        value={rule.toUserId ? `user:${rule.toUserId}` : `role:${rule.toRole ?? 'bdr'}`}
                        onChange={(v) => {
                          const [kind, id] = v.split(':');
                          update(i, kind === 'user' ? { toUserId: id, toRole: null } : { toUserId: null, toRole: id });
                        }}
                        width="w-64"
                      >
                        <optgroup label="A role — spread by quota">
                          {RECEIVING_ROLES.map((r) => (
                            <option key={r} value={`role:${r}`}>
                              {roleLabel(r)}
                              {staffedRoles.has(r) ? '' : ' (nobody active)'}
                            </option>
                          ))}
                        </optgroup>
                        {active.length > 0 ? (
                          <optgroup label="One person — ignores quota spreading">
                            {active.map((u) => (
                              <option key={u.id} value={`user:${u.id}`}>
                                {u.name} · {roleLabel(u.role)}
                              </option>
                            ))}
                          </optgroup>
                        ) : null}
                      </Choose>
                    </div>
                    {unstaffed ? (
                      <p className="text-warning mt-2 text-[11px]">
                        No active user holds this role, so this rule will match leads and then assign none of them.
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}

        <div className="text-muted flex items-center gap-2 px-4 py-2.5 text-[11px] italic">
          <span className="text-subtle w-5 shrink-0 text-right">·</span>
          Anything matching no rule stays unassigned and visible to everyone whose scope covers it.
        </div>
      </div>

      <div className="border-border-base flex flex-wrap items-center gap-3 border-t px-5 py-3">
        <Button variant="primary" size="sm" onClick={save} disabled={busy || !dirty}>
          {busy ? 'Saving…' : dirty ? 'Save rules' : 'Saved'}
        </Button>
        {dirty ? (
          <Button size="sm" variant="ghost" onClick={() => setRules(initialRules)}>
            Discard changes
          </Button>
        ) : null}
        {msg ? <span className={`text-[11px] ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</span> : null}
        <span className="text-subtle ml-auto text-[10px]">
          {rules.length} rule{rules.length === 1 ? '' : 's'} · {active.length} person
          {active.length === 1 ? '' : 's'} able to receive
        </span>
      </div>
    </div>
  );
}
