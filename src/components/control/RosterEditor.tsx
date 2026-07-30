'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, ChevronDown } from 'lucide-react';
import { BUSINESS_UNITS, BU_LABELS, VERTICALS, titleize } from '@/lib/semantics';
import { ROLE_LABELS, type Role } from '@/lib/auth/roles';
import { Badge, Button, Card, CardHeader, Label, controlClass } from '@/components/ui';

export interface RosterRow {
  id: string;
  name: string;
  email: string | null;
  role: string;
  bu: string[];
  verticals: string[];
  regions: string[];
  preferred_verticals: string[];
  daily_lead_quota: number;
  is_active: boolean;
  /** Set when this person also has an app account. */
  user_id: string | null;
  /** Leads they currently hold. */
  openLeads?: number;
}

const RECEIVING_ROLES = ['bdr', 'sdr', 'ae', 'marketing', 'sales_manager'];
const QUOTAS = [0, 10, 25, 50, 75, 100, 200, 300, 500, 750, 1000];

const roleLabel = (r: string) => ROLE_LABELS[r as Role] ?? titleize(r);

/** A list-valued field as toggle chips. */
function Chips({
  label,
  hint,
  choices,
  selected,
  labelFor,
  onChange,
}: {
  label: string;
  hint: string;
  choices: readonly string[];
  selected: string[];
  labelFor?: (v: string) => string;
  onChange: (next: string[]) => void;
}) {
  return (
    <div>
      <Label hint={selected.length === 0 ? hint : `${selected.length} selected`}>{label}</Label>
      <div className="mt-1 flex flex-wrap gap-1">
        {choices.map((c) => {
          const on = selected.includes(c);
          return (
            <button
              key={c}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? selected.filter((x) => x !== c) : [...selected, c])}
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

/**
 * Who can receive leads.
 *
 * Owning a lead used to require an invitation and an accepted account, because
 * ownership pointed at an auth user. That is the wrong shape for how this
 * runs: an admin builds the list and hands it to a BDR, and what the BDR needs
 * is their name on the record and on the sheet — not a login to a tool they
 * never open.
 *
 * So this is a roster. Add a name and they can be assigned to. If they also
 * happen to have an app account it is linked, which is what makes "My Leads"
 * work for them, but nothing here depends on it.
 */
export default function RosterEditor({
  rows,
  tableMissing,
  apolloUsers,
}: {
  rows: RosterRow[];
  tableMissing: boolean;
  /**
   * Apollo workspace members not already on the roster, with the role and
   * business unit their title and territory imply. Resolved on the server.
   */
  apolloUsers: {
    name: string;
    email: string;
    title: string | null;
    territories: string[];
    role: string;
    bu: string[];
    because: string | null;
  }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [draft, setDraft] = useState<{ name: string; email: string; role: string; bu: string[] }>({
    name: '',
    email: '',
    role: 'bdr',
    bu: [],
  });

  async function call(action: string, payload: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const json = await res.json();
      setMsg({ ok: json.ok, text: json.message });
      if (json.ok) router.refresh();
      return json.ok as boolean;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!draft.email) {
      setMsg({ ok: false, text: 'Choose someone from Apollo first.' });
      return;
    }
    if (await call('saveAssignee', { assignee: draft })) {
      setDraft({ name: '', email: '', role: draft.role, bu: [] });
      // The server owns the directory, so re-rendering the page is what drops
      // the person just added out of the list.
      router.refresh();
    }
  }

  if (tableMissing) {
    return (
      <Card>
        <CardHeader title="Who receives leads" />
        <div className="border-warning/40 bg-warning/10 text-warning m-5 rounded-lg border px-4 py-3 text-[11px]">
          Run the <code className="font-mono">assignees</code> migration to manage the roster here.
        </div>
      </Card>
    );
  }

  const active = rows.filter((r) => r.is_active);
  const capacity = active.reduce((n, r) => n + r.daily_lead_quota, 0);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={`Who receives leads (${active.length})`}
        subtitle="Picked from the Apollo workspace. No invitation needed — being on this list is what makes someone assignable."
        action={<span className="text-subtle text-[11px] tabular-nums">{capacity.toLocaleString()} leads/day capacity</span>}
      />

      <div className="border-border-base border-b px-5 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <Label hint={`${apolloUsers.length} available`}>Add from Apollo</Label>
            <select
              value={draft.email}
              disabled={apolloUsers.length === 0}
              onChange={(e) => {
                const picked = apolloUsers.find((u) => u.email === e.target.value);
                // Name and address are taken together — two halves of one
                // identity. Role and unit come with them because Apollo
                // already knows the answer, and both stay editable below.
                setDraft({
                  name: picked?.name ?? '',
                  email: picked?.email ?? '',
                  role: picked?.role ?? 'bdr',
                  bu: picked?.bu ?? [],
                });
              }}
              className={`${controlClass} w-72`}
            >
              <option value="">
                {apolloUsers.length ? 'Select someone…' : 'Everyone in Apollo is already on the roster'}
              </option>
              {apolloUsers.map((u) => (
                <option key={u.email} value={u.email}>
                  {u.name}
                  {u.title ? ` · ${u.title}` : ''}
                  {u.territories.length ? ` · ${u.territories.join('/')}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <Label>Role</Label>
            <select
              value={draft.role}
              onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}
              className={`${controlClass} w-40`}
            >
              {RECEIVING_ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="primary"
            onClick={add}
            disabled={busy || !draft.email}
            className="flex items-center gap-1.5"
          >
            <Plus size={12} strokeWidth={2.4} />
            Add to roster
          </Button>
          <button
            type="button"
            onClick={() => router.refresh()}
            className="text-muted hover:text-foreground pb-2 text-[11px] underline"
          >
            Refresh
          </button>
          {msg ? <span className={`pb-2 text-[11px] ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</span> : null}
        </div>

        {draft.email ? (
          <p className="text-muted mt-2 text-[11px]">
            {(() => {
              const picked = apolloUsers.find((u) => u.email === draft.email);
              if (!picked?.because) return `${draft.name} — Apollo gives no title or territory, so this defaults to BDR.`;
              return `From Apollo: ${picked.because}${
                draft.bu.length ? ` — scoped to ${draft.bu.map((b) => b.toUpperCase()).join(', ')}` : ''
              }. Change the role above if that is wrong.`;
            })()}
          </p>
        ) : null}
        <p className="text-subtle mt-2 max-w-2xl text-[11px]">
          Only people who exist in Apollo can be added. The export attaches a lead&rsquo;s owner by email, so an address
          typed by hand that does not match exactly exports the contact with no owner and reports nothing.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted px-5 py-6 text-[11px]">
          Nobody on the roster yet. Every assignment rule will match leads and then find no one to give them to.
        </p>
      ) : (
        <div>
          {rows.map((r) => {
            const isOpen = open === r.id;
            return (
              <div key={r.id} className="border-border-base border-b last:border-b-0">
                <div className={`flex flex-wrap items-center gap-2 px-4 py-2.5 ${r.is_active ? '' : 'opacity-50'}`}>
                  <button type="button" onClick={() => setOpen(isOpen ? null : r.id)} className="min-w-0 flex-1 text-left">
                    <span className="text-foreground text-[12px] font-bold">{r.name}</span>
                    <span className="text-muted block truncate text-[11px]">
                      {roleLabel(r.role)}
                      {r.email ? ` · ${r.email}` : ''}
                      {r.bu.length ? ` · ${r.bu.map((b) => BU_LABELS[b] ?? b).join(', ')}` : ' · all BUs'}
                      {r.verticals.length ? ` · ${r.verticals.length} verticals` : ''}
                    </span>
                  </button>

                  {r.user_id ? <Badge tone="info">has a login</Badge> : null}
                  {!r.is_active ? <Badge tone="neutral">inactive</Badge> : null}
                  <span className="text-subtle shrink-0 text-[10px] tabular-nums" title="open leads / daily quota">
                    {(r.openLeads ?? 0).toLocaleString()} / {r.daily_lead_quota}
                  </span>
                  <ChevronDown size={14} className={`text-subtle ${isOpen ? 'rotate-180' : ''}`} />
                </div>

                {isOpen ? (
                  <div className="border-border-base bg-surface-raised animate-rise-in space-y-4 border-t px-5 py-4">
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="block">
                        <Label>Name</Label>
                        <input
                          defaultValue={r.name}
                          onBlur={(e) =>
                            e.target.value.trim() !== r.name &&
                            call('saveAssignee', { assignee: { id: r.id, name: e.target.value } })
                          }
                          className={`${controlClass} w-44`}
                        />
                      </label>
                      <label className="block">
                        <Label>Email</Label>
                        <input
                          defaultValue={r.email ?? ''}
                          onBlur={(e) =>
                            e.target.value.trim() !== (r.email ?? '') &&
                            call('saveAssignee', { assignee: { id: r.id, email: e.target.value } })
                          }
                          className={`${controlClass} w-52`}
                        />
                      </label>
                      <label className="block">
                        <Label>Role</Label>
                        <select
                          value={r.role}
                          onChange={(e) => call('saveAssignee', { assignee: { id: r.id, role: e.target.value } })}
                          className={`${controlClass} w-40`}
                        >
                          {RECEIVING_ROLES.map((x) => (
                            <option key={x} value={x}>
                              {roleLabel(x)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <Label hint="leads a day">Quota</Label>
                        <select
                          value={r.daily_lead_quota}
                          onChange={(e) =>
                            call('saveAssignee', { assignee: { id: r.id, daily_lead_quota: Number(e.target.value) } })
                          }
                          className={`${controlClass} w-28`}
                        >
                          {(QUOTAS.includes(r.daily_lead_quota) ? QUOTAS : [...QUOTAS, r.daily_lead_quota].sort((a, b) => a - b)).map((q) => (
                            <option key={q} value={q}>
                              {q === 0 ? 'Paused' : q}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <Label>Status</Label>
                        <select
                          value={r.is_active ? 'on' : 'off'}
                          onChange={(e) =>
                            call('saveAssignee', { assignee: { id: r.id, is_active: e.target.value === 'on' } })
                          }
                          className={`${controlClass} w-28`}
                        >
                          <option value="on">Active</option>
                          <option value="off">Paused</option>
                        </select>
                      </label>
                    </div>

                    <div className="space-y-3">
                      <Chips
                        label="Business units"
                        hint="any BU"
                        choices={BUSINESS_UNITS}
                        selected={r.bu}
                        labelFor={(v) => BU_LABELS[v] ?? titleize(v)}
                        onChange={(bu) => call('saveAssignee', { assignee: { id: r.id, bu } })}
                      />
                      <Chips
                        label="Verticals they can work"
                        hint="any vertical"
                        choices={VERTICALS}
                        selected={r.verticals}
                        onChange={(verticals) => call('saveAssignee', { assignee: { id: r.id, verticals } })}
                      />
                      <Chips
                        label="Verticals they prefer"
                        hint="no preference"
                        choices={VERTICALS}
                        selected={r.preferred_verticals}
                        onChange={(preferred_verticals) =>
                          call('saveAssignee', { assignee: { id: r.id, preferred_verticals } })
                        }
                      />
                    </div>

                    <p className="text-subtle text-[11px]">
                      <strong>Can work</strong> is a hard limit — a lead outside it is never assigned to them.{' '}
                      <strong>Prefer</strong> only breaks ties between people who are equally free, so an account tends
                      to stay with whoever is building it.
                    </p>

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => call('removeAssignee', { id: r.id })}
                      className="text-danger flex items-center gap-1.5"
                    >
                      <Trash2 size={12} />
                      Remove — their leads go back to the pool
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
