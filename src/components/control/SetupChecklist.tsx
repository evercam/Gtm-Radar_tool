'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Play, Plus } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Label, controlClass } from '@/components/ui';

type Channel = 'phone' | 'email' | 'both' | 'any' | 'none';

export interface SetupState {
  counts: { total: number; scored: number; routed: number; queued: number; enriched: number; assigned: number; exported: number };
  contacts: { withPhone: number; withEmail: number; verified: number };
  channelRules: Record<string, Channel>;
  policy: Record<string, unknown>;
  roster: { id: string; name: string; email: string | null; role: string }[];
  assignmentRules: { id: string; name: string; enabled: boolean; toRole: string | null; toUserId: string | null }[];
  rulesRaw: Record<string, unknown>[];
  rulesCanReachSomeone: boolean;
  cronConfigured: boolean;
}

const CHANNELS: { value: Channel; label: string }[] = [
  { value: 'phone', label: 'A phone number' },
  { value: 'email', label: 'An email' },
  { value: 'any', label: 'Either one' },
  { value: 'both', label: 'Both' },
  { value: 'none', label: 'Nothing' },
];

const LANES = [
  { key: 'act_now', label: 'Sales · act now' },
  { key: 'qualify', label: 'Sales · qualify' },
  { key: 'nurture', label: 'Marketing · nurture' },
];

/**
 * How work currently reaches people.
 *
 * Says the roster part first, because that is now what does the work: a lead no
 * authored rule claims goes to whoever on the roster covers it and has the most
 * room. Rules are the exception layer on top, so a count of them is the detail,
 * not the headline.
 */
function describeReach(state: SetupState): string {
  const active = state.assignmentRules.filter((r) => r.enabled).length;
  const people = `${state.roster.length} on the roster receive by scope and quota`;
  return active > 0
    ? `${people}; ${active} rule${active === 1 ? '' : 's'} route specific leads first.`
    : `${people}. No rules needed — add one only to send particular leads somewhere particular.`;
}

/**
 * Why no enabled rule reaches a real person.
 *
 * This used to read "Rules target nobody — no active person holds those roles"
 * for every cause, which was misleading in the most common one: a rule pointing
 * at a person by id who has since left the roster targets somebody very
 * specifically, and no role is involved at all. Naming the actual cause is the
 * difference between a step someone can clear and one they stare at.
 */
function whyRulesReachNobody(state: SetupState): string {
  const enabled = state.assignmentRules.filter((r) => r.enabled);
  if (enabled.length === 0) {
    return state.assignmentRules.length === 0
      ? 'No assignment rules yet — nothing is handed out until one exists.'
      : `${state.assignmentRules.length} rule(s) exist but all are disabled.`;
  }

  const rosterIds = new Set(state.roster.map((p) => p.id));
  const rosterRoles = new Set(state.roster.map((p) => p.role));

  const orphaned = enabled.filter((r) => r.toUserId && !rosterIds.has(r.toUserId));
  const deadRoles = [...new Set(enabled.map((r) => r.toRole).filter((x): x is string => Boolean(x)))].filter(
    (role) => !rosterRoles.has(role)
  );
  // A rule naming no recipient is no longer a fault — it means "anyone on the
  // roster who covers it" — so it is not listed as a reason here.
  const reasons: string[] = [];
  if (orphaned.length) {
    reasons.push(
      `${orphaned.length === 1 ? `“${orphaned[0].name}” targets` : `${orphaned.length} rules target`} someone who is no longer on the roster`
    );
  }
  if (deadRoles.length) reasons.push(`no active person holds ${deadRoles.join(' or ')}`);

  return reasons.length
    ? `${reasons.join('; ')}. Point a rule at someone on the roster below.`
    : 'No enabled rule resolves to an active person on the roster.';
}

/**
 * The setup checklist.
 *
 * Ordered by dependency, not importance: a step cannot be judged until the one
 * above it passes, so each is shown with what it is currently blocked by
 * rather than a bare tick. Every step carries its own fix, because the whole
 * point is not having to find the right screen.
 */
export default function SetupChecklist({
  state,
  rulesEditor,
}: {
  state: SetupState;
  /**
   * The assignment-rules editor, rendered inside the "a rule that reaches them"
   * step. Passed in as a slot rather than imported here so the server page keeps
   * assembling its data — the editor needs the full roster with BUs, verticals
   * and regions, and threading all of that through SetupState would duplicate it
   * for the sake of an import.
   */
  rulesEditor?: ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<{ step: string; ok: boolean; text: string }[]>([]);
  const [draft, setDraft] = useState({ name: '', email: '', role: 'bdr' });
  // The Apollo directory. Loaded when this step is reached rather than with
  // the page: it is a live API call, and most visits here are not adding
  // anyone.
  const [directory, setDirectory] = useState<{ name: string; email: string; onRoster: boolean }[] | null>(null);
  const [loadingDir, setLoadingDir] = useState(false);
  const [manual, setManual] = useState(false);
  const [rules, setRules] = useState(state.channelRules);

  const say = (step: string, ok: boolean, text: string) => setLog((l) => [{ step, ok, text }, ...l].slice(0, 8));

  async function post(step: string, url: string, body: unknown) {
    setBusy(step);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      say(step, json.ok !== false, json.message ?? `HTTP ${res.status}`);
      router.refresh();
      return json;
    } catch (e) {
      say(step, false, e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function loadDirectory() {
    setLoadingDir(true);
    try {
      const res = await fetch('/api/apollo/users');
      const json = await res.json();
      if (json.ok === false) {
        say('roster', false, json.message ?? 'Could not read the Apollo directory.');
        // Falling back to typing beats a dead end when Apollo is unreachable.
        setManual(true);
        setDirectory([]);
      } else {
        setDirectory(json.users);
        if (json.users.length === 0) setManual(true);
      }
    } catch (e) {
      say('roster', false, e instanceof Error ? e.message : String(e));
      setManual(true);
      setDirectory([]);
    } finally {
      setLoadingDir(false);
    }
  }

  const { counts, contacts } = state;

  // What each lane needs, against what the database can actually supply.
  const supplyFor = (ch: Channel) =>
    ch === 'phone' ? contacts.withPhone : ch === 'email' ? contacts.withEmail : ch === 'any' ? contacts.withEmail + contacts.withPhone : ch === 'both' ? 0 : counts.total;

  const steps = [
    {
      id: 'roster',
      title: 'Someone to receive leads',
      done: state.roster.length > 0,
      blocked: null as string | null,
      detail:
        state.roster.length > 0
          ? `${state.roster.length} on the roster: ${state.roster.map((r) => r.name).join(', ')}`
          : 'Nobody can be assigned to. No invitation needed — a name is enough.',
    },
    {
      id: 'rules',
      title: 'A rule that reaches them',
      done: state.rulesCanReachSomeone,
      blocked: state.roster.length === 0 ? 'Add someone first' : null,
      detail: state.rulesCanReachSomeone
        ? describeReach(state)
        : whyRulesReachNobody(state),
    },
    {
      id: 'channel',
      title: 'A channel rule the data can satisfy',
      done: LANES.some((l) => supplyFor(rules[l.key] ?? 'none') > 0),
      blocked: null,
      detail: `${contacts.withPhone} records have a phone, ${contacts.withEmail} have an email.`,
    },
    {
      id: 'enrich',
      title: 'Enrich the queue',
      done: counts.enriched > 0,
      blocked: counts.queued === 0 ? 'Nothing selected yet — run prioritisation' : null,
      detail: `${counts.queued.toLocaleString()} queued · ${counts.enriched.toLocaleString()} enriched.`,
    },
    {
      id: 'assign',
      title: 'Give them an owner',
      done: counts.assigned > 0,
      blocked: counts.enriched === 0 ? 'Nothing has reached ENRICHED' : null,
      detail: `${counts.assigned.toLocaleString()} assigned.`,
    },
    {
      id: 'export',
      title: 'Send to Apollo',
      done: counts.exported > 0,
      blocked:
        counts.assigned === 0 ? 'Nothing assigned' : contacts.verified === 0 ? 'No verified emails yet' : null,
      detail: `${contacts.verified.toLocaleString()} verified emails · ${counts.exported.toLocaleString()} exported.`,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Where the pipeline currently stops */}
      <Card>
        <CardHeader title="The chain" subtitle="Each stage reads what the one before it wrote" />
        <div className="flex flex-wrap gap-3 px-5 py-4">
          {[
            ['Ingested', counts.total],
            ['Scored', counts.scored],
            ['Routed', counts.routed],
            ['Queued', counts.queued],
            ['Enriched', counts.enriched],
            ['Assigned', counts.assigned],
            ['Exported', counts.exported],
          ].map(([label, n], i, all) => {
            const num = n as number;
            const prev = i === 0 ? Infinity : (all[i - 1][1] as number);
            // The first stage that drops to zero while the one before it did
            // not is where the pipeline actually stops.
            const isBreak = num === 0 && prev > 0;
            return (
              <div
                key={label as string}
                className={`min-w-24 rounded-lg border px-3 py-2 ${
                  isBreak ? 'border-danger/40 bg-danger/5' : 'border-border-base bg-surface'
                }`}
              >
                <p className="text-muted text-[10px] font-bold uppercase tracking-widest">{label as string}</p>
                <p className={`mt-0.5 text-lg font-bold tabular-nums ${isBreak ? 'text-danger' : 'text-foreground'}`}>
                  {num.toLocaleString()}
                </p>
                {isBreak ? <p className="text-danger text-[10px]">stops here</p> : null}
              </div>
            );
          })}
        </div>
      </Card>

      {/* The checklist */}
      <Card className="overflow-hidden">
        <CardHeader title="What to do, in order" />
        <div>
          {steps.map((step, i) => (
            <div key={step.id} className="border-border-base border-b px-5 py-4 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    step.done ? 'bg-success/15 text-success' : 'bg-surface-raised text-muted'
                  }`}
                >
                  {step.done ? <Check size={12} strokeWidth={3} /> : i + 1}
                </span>
                <span className="text-foreground text-[13px] font-bold">{step.title}</span>
                {step.done ? <Badge tone="success">done</Badge> : null}
                {step.blocked ? <Badge tone="warning">{step.blocked}</Badge> : null}
              </div>
              <p className="text-muted ml-7 mt-1 text-[11px]">{step.detail}</p>

              {/* --- 1 · roster --- */}
              {step.id === 'roster' ? (
                <div className="ml-7 mt-3">
                  {directory === null ? (
                    <Button size="sm" disabled={loadingDir} onClick={loadDirectory}>
                      {loadingDir ? 'Loading…' : 'Choose from Apollo'}
                    </Button>
                  ) : (
                    <div className="flex flex-wrap items-end gap-3">
                      {manual ? (
                        <>
                          <label className="block">
                            <Label>Name</Label>
                            <input
                              value={draft.name}
                              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                              placeholder="Jose Sanchez"
                              className={`${controlClass} w-40`}
                            />
                          </label>
                          <label className="block">
                            <Label hint="must match their Apollo user exactly">Email</Label>
                            <input
                              value={draft.email}
                              onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                              placeholder="jose.sanchez@evercam.io"
                              className={`${controlClass} w-56`}
                            />
                          </label>
                        </>
                      ) : (
                        <label className="block">
                          <Label hint={`${directory.filter((u) => !u.onRoster).length} not yet on the roster`}>
                            Who receives leads
                          </Label>
                          <select
                            value={draft.email}
                            onChange={(e) => {
                              const picked = directory.find((u) => u.email === e.target.value);
                              // Name and address travel together — picking one
                              // and typing the other is how they drift apart.
                              setDraft((d) => ({ ...d, email: picked?.email ?? '', name: picked?.name ?? '' }));
                            }}
                            className={`${controlClass} w-72`}
                          >
                            <option value="">Select someone…</option>
                            {directory
                              .filter((u) => !u.onRoster)
                              .map((u) => (
                                <option key={u.email} value={u.email}>
                                  {u.name} — {u.email}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}

                      <label className="block">
                        <Label>Role</Label>
                        <select
                          value={draft.role}
                          onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}
                          className={`${controlClass} w-32`}
                        >
                          {['bdr', 'sdr', 'ae', 'marketing'].map((r) => (
                            <option key={r} value={r}>
                              {r.toUpperCase()}
                            </option>
                          ))}
                        </select>
                      </label>

                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy !== null || !draft.name.trim()}
                        onClick={async () => {
                          const ok = await post('roster', '/api/leads', { action: 'saveAssignee', assignee: draft });
                          if (ok?.ok) {
                            setDraft({ name: '', email: '', role: 'bdr' });
                            await loadDirectory();
                          }
                        }}
                        className="flex items-center gap-1.5"
                      >
                        <Plus size={12} strokeWidth={2.4} />
                        Add
                      </Button>

                      <button
                        type="button"
                        onClick={() => {
                          setManual(!manual);
                          setDraft({ name: '', email: '', role: draft.role });
                        }}
                        className="text-muted hover:text-foreground pb-2 text-[11px] underline"
                      >
                        {manual ? 'Pick from Apollo instead' : 'Someone not in Apollo'}
                      </button>
                    </div>
                  )}

                  <p className="text-subtle mt-2 max-w-2xl text-[11px]">
                    Picked from the Apollo workspace so the address matches exactly — the export attaches a lead&rsquo;s
                    owner by email, and a typo there exports the contact with no owner and reports nothing.
                  </p>
                </div>
              ) : null}

              {/* --- 2 · rules --- */}
              {step.id === 'rules' ? (
                <div className="ml-7 mt-3 flex flex-wrap items-center gap-3">
                  {state.roster.length > 0 && !state.rulesCanReachSomeone ? (
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        post('rules', '/api/leads', {
                          action: 'saveRules',
                          rules: [
                            ...state.rulesRaw,
                            {
                              id: 'everything_to_' + state.roster[0].id.slice(0, 8),
                              name: `Everything to ${state.roster[0].name}`,
                              // Last resort: every other rule gets first refusal.
                              priority: 999,
                              enabled: true,
                              conditions: {},
                              toUserId: state.roster[0].id,
                              toRole: null,
                            },
                          ],
                        })
                      }
                    >
                      Send everything to {state.roster[0].name}
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {/*
                The rules editor itself, in the step it belongs to. It used to sit
                in its own section further down the page, reached by a link — and
                before that, by a link to the page you were already on. Inlining it
                is the same principle the rest of this checklist follows: the fix
                lives next to the finding, so nobody has to work out which screen
                to go to.
              */}
              {step.id === 'rules' && rulesEditor ? <div className="ml-7 mt-4">{rulesEditor}</div> : null}

              {/* --- 3 · channel --- */}
              {step.id === 'channel' ? (
                <div className="ml-7 mt-3">
                  <div className="flex flex-wrap items-end gap-3">
                    {LANES.map((lane) => {
                      const ch = rules[lane.key] ?? 'none';
                      const supply = supplyFor(ch);
                      return (
                        <label key={lane.key} className="block">
                          <Label hint={supply === 0 ? 'nothing qualifies' : `${supply.toLocaleString()} qualify`}>
                            {lane.label}
                          </Label>
                          <select
                            value={ch}
                            onChange={(e) => setRules((r) => ({ ...r, [lane.key]: e.target.value as Channel }))}
                            className={`${controlClass} w-40`}
                          >
                            {CHANNELS.map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    })}
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy !== null}
                      onClick={() =>
                        post('channel', '/api/policy/enrichment', {
                          config: { ...state.policy, channelRules: rules },
                        })
                      }
                    >
                      Save channel rules
                    </Button>
                  </div>
                  <p className="text-subtle mt-2 text-[11px]">
                    A lead only leaves enrichment once it carries what its lane is worked through. Demanding a phone
                    is right for a calling motion and stops everything when the database holds{' '}
                    {contacts.withPhone} of them.
                  </p>
                </div>
              ) : null}

              {/* --- 4-6 · the runs --- */}
              {['enrich', 'assign', 'export'].includes(step.id) ? (
                <div className="ml-7 mt-3 flex flex-wrap gap-2">
                  {step.id === 'enrich' ? (
                    <>
                      <Button size="sm" disabled={busy !== null} onClick={() => post('enrich', '/api/prioritize', {})}>
                        1 · Select what to enrich
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => post('enrich', '/api/enrich/batch', { dryRun: true })}
                      >
                        Dry run
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy !== null}
                        onClick={() => post('enrich', '/api/enrich/batch', {})}
                        className="flex items-center gap-1.5"
                      >
                        <Play size={11} strokeWidth={2.4} />2 · Enrich a batch
                      </Button>
                    </>
                  ) : null}
                  {step.id === 'assign' ? (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy !== null}
                      onClick={() => post('assign', '/api/leads', { action: 'autoAssign' })}
                      className="flex items-center gap-1.5"
                    >
                      <Play size={11} strokeWidth={2.4} />
                      Run assignment
                    </Button>
                  ) : null}
                  {step.id === 'export' ? (
                    <>
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => post('export', '/api/export/apollo', { dryRun: true })}
                      >
                        Dry run — see the payload
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy !== null}
                        onClick={() => post('export', '/api/export/apollo', {})}
                        className="flex items-center gap-1.5"
                      >
                        <Play size={11} strokeWidth={2.4} />
                        Send to Apollo
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </Card>

      {log.length > 0 ? (
        <Card>
          <CardHeader title="What happened" />
          <ul className="divide-border-base divide-y">
            {log.map((l, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-3 px-5 py-2.5 text-[11px]">
                <Badge tone={l.ok ? 'success' : 'danger'}>{l.step}</Badge>
                <span className="text-body min-w-0 flex-1">{l.text}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {!state.cronConfigured ? (
        <p className="text-subtle text-[11px]">
          Once this runs by hand, set <code className="font-mono">CRON_SECRET</code> and point a scheduler at{' '}
          <code className="font-mono">/api/cron?job=daily</code> so it runs without you.
        </p>
      ) : null}
    </div>
  );
}
