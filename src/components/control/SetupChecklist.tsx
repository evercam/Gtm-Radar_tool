'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Play } from 'lucide-react';
import { Badge, Button, Card, CardHeader, Label, controlClass } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

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
export default function SetupChecklist({ state }: { state: SetupState }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<{ step: string; ok: boolean; text: string }[]>([]);
  const [rules, setRules] = useState(state.channelRules);
  /** Roster id to export for, or '' for everyone. See the picker below. */
  const [exportAssignee, setExportAssignee] = useState('');

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
      const ok = json.ok !== false;
      const text = json.message ?? `HTTP ${res.status}`;
      say(step, ok, text);
      /*
        The log below the checklist is only visible if you are looking at it, and
        an export takes long enough that you have usually scrolled away or moved
        to another tab. The toast is the part that reaches you — it is the only
        in-app signal a send finished, since Apollo raises no notification of its
        own.
      */
      toast.show(text, ok ? 'success' : 'error');
      router.refresh();
      return json;
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      say(step, false, text);
      toast.show(text, 'error');
      return null;
    } finally {
      setBusy(null);
    }
  }

  const { counts, contacts } = state;

  // What each lane needs, against what the database can actually supply.
  const supplyFor = (ch: Channel) =>
    ch === 'phone' ? contacts.withPhone : ch === 'email' ? contacts.withEmail : ch === 'any' ? contacts.withEmail + contacts.withPhone : ch === 'both' ? 0 : counts.total;

  const steps = [
    // One step for the whole assignment concern, and it reports rather than
    // controls. It used to be three — a roster, a rule, and a run — each with its
    // own editor or button, duplicating the Assignment section further down the
    // page. A lead is assigned once by one pass, so there is one place to set that
    // up; this only says whether it is working.
    {
      id: 'assignment',
      title: 'Leads reach a person',
      done: state.roster.length > 0 && state.rulesCanReachSomeone,
      blocked: null as string | null,
      detail:
        state.roster.length === 0
          ? 'Nobody can be assigned to. Add someone under Assignment below — no invitation needed, a name is enough.'
          : state.rulesCanReachSomeone
            ? `${describeReach(state)} ${counts.assigned.toLocaleString()} assigned so far.`
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
                  {/*
                    No "Run assignment" here. It posted the same autoAssign the
                    Distribution card fires, and two buttons for one irreversible
                    pass is how you get a double run and a confused report of which
                    one moved what.
                  */}
                  {step.id === 'export' ? (
                    <>
                      {/*
                        Who this run is for. Everyone by default, because that is
                        the normal run; one person when a BDR needs their own
                        sheet filled without waiting for the rest of the book.
                        The selection is carried by BOTH buttons, so a dry run
                        never previews a different set than the send.
                      */}
                      <select
                        aria-label="Export for"
                        className={controlClass}
                        value={exportAssignee}
                        disabled={busy !== null}
                        onChange={(e) => setExportAssignee(e.target.value)}
                      >
                        <option value="">Everyone on the roster</option>
                        {state.roster.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} only
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() =>
                          post('export', '/api/export/apollo', {
                            dryRun: true,
                            ...(exportAssignee ? { assignee: exportAssignee } : {}),
                          })
                        }
                      >
                        Dry run — see the payload
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy !== null}
                        onClick={() =>
                          post('export', '/api/export/apollo', {
                            ...(exportAssignee ? { assignee: exportAssignee } : {}),
                          })
                        }
                        className="flex items-center gap-1.5"
                      >
                        <Play size={11} strokeWidth={2.4} />
                        {exportAssignee
                          ? `Send ${state.roster.find((p) => p.id === exportAssignee)?.name ?? 'their'} leads`
                          : 'Send to Apollo'}
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
