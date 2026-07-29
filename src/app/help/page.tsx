import { requireUser } from '@/lib/auth/session';
import { getScoringPolicies, getEnrichmentPolicy } from '@/lib/policies';
import { getRoutingPolicy } from '@/lib/queries';
import { getAssignmentRules, getAllocationPolicy, getRoster } from '@/lib/assignmentStore';
import { describeAllocation } from '@/lib/allocation';
import type { RoutingRule } from '@/lib/routing';
import { BU_LABELS } from '@/lib/semantics';
import { Card, CardBody, CardHeader } from '@/components/ui';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * How the machine decides — written for whoever has to trust its output.
 *
 * Every number on this page is read from the live policy rows, not from the
 * documentation defaults. A help page that describes the built-in settings
 * while the workspace runs different ones is worse than no help page: it
 * teaches people a model that does not match what they are looking at, and
 * they only discover the gap when a lead lands somewhere they did not expect.
 *
 * Ordered as the pipeline runs — score, route, enrich, assign — because every
 * stage consumes the previous one's output, and that dependency is the single
 * most useful thing a new seller can understand about the system.
 */

const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

function Term({ children }: { children: React.ReactNode }) {
  return <span className="text-foreground font-semibold">{children}</span>;
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <div className="flex items-baseline gap-3">
        <span className="bg-brand text-brand-contrast flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold">
          {n}
        </span>
        <h2 className="text-foreground text-xl font-bold tracking-tight">{title}</h2>
      </div>
      <div className="mt-3 space-y-4 pl-9">{children}</div>
    </section>
  );
}

export default async function HelpPage() {
  await requireUser('/help');
  if (!isSupabaseServerConfigured()) return <SupabaseNotConfigured />;

  const [scoring, enrichment, routing, assignment, allocation, roster] = await Promise.all([
    getScoringPolicies(),
    getEnrichmentPolicy(),
    getRoutingPolicy(),
    getAssignmentRules(),
    getAllocationPolicy(),
    getRoster(),
  ]);

  const cfg = scoring.byBu.default;
  const w = cfg.weights;
  const totalWeight = w.timing + w.scale + w.icpFit + w.contact + w.keyAccount + w.freshness;
  const policy = enrichment.config;
  const rules: RoutingRule[] = routing.rules.filter((r) => r.enabled !== false);
  const activeAssignment = assignment.rules.filter((r) => r.enabled !== false);
  const receiving = roster.rows.filter((r) => r.is_active);
  const capacity = receiving.reduce((n, r) => n + r.daily_lead_quota, 0);

  const components = [
    {
      label: 'How close it is to breaking ground',
      weight: w.timing,
      body:
        'The single biggest factor. Evercam gets bought when a site is about to start, so a project at ' +
        '“pre-construction” or “contract awarded” scores full marks, one still “in planning” scores about a third, ' +
        'and one that is finished or cancelled scores nothing at all.',
    },
    {
      label: 'How big it is',
      weight: w.scale,
      body: `Money if we know it, megawatts if we do not — whichever signal is stronger, never both added together. A project reaches full marks at ${(cfg.valueSaturation / 1_000_000).toLocaleString()}M or ${cfg.capacitySaturation_MW.toLocaleString()} MW; beyond that it stops counting for more.`,
    },
    {
      label: 'Whether it is the kind of company we win',
      weight: w.icpFit,
      body: `Full marks for a strategic profile (${cfg.strategicIcps.join(', ').replace(/_/g, ' ')}), half for a secondary one, with a top-up when the sector is one of the ${cfg.coreVerticals.length} we sell into best.`,
    },
    {
      label: 'Whether we can reach anyone',
      weight: w.contact,
      body: 'A named person with an email scores full marks, an email or phone on its own three quarters, a name alone under half, and nothing at all scores zero.',
    },
    {
      label: 'Whether the company already matters to us',
      weight: w.keyAccount,
      body: 'Full marks for a flagged key account. This one only appears after enrichment has looked the company up, so a brand-new record cannot earn it yet.',
    },
    {
      label: 'How recent it is',
      weight: w.freshness,
      body: `Fades evenly to nothing over ${cfg.freshnessWindowDays} days. A record with no date at all sits in the middle — neither rewarded nor punished for something we simply do not know.`,
    },
  ].sort((a, b) => b.weight - a.weight);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-foreground text-2xl font-bold">How leads are chosen and shared out</h1>
      <p className="text-muted mt-2 text-sm">
        Four things happen to every record, in order. Each one uses what the step before it decided, which is why a
        problem early on shows up as an empty result much later.
      </p>
      <p className="text-subtle mt-2 text-xs">
        Every number below is read from the settings this workspace is running right now — not from an example.
      </p>

      {/* ---------------------------------------------------------------- */}
      <Step n={1} title="Scoring — how urgent is it?">
        <p className="text-body text-sm">
          Every record gets a score out of 100. It is not a guess: six things are measured, each worth a fixed share of
          the total, and they are added up.
        </p>

        <Card>
          <CardHeader title="What the score is made of" subtitle="Largest share first" />
          <CardBody className="space-y-4">
            {components.map((c) => (
              <div key={c.label}>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-foreground text-[13px] font-semibold">{c.label}</p>
                  <span className="text-muted shrink-0 text-xs tabular-nums">
                    {pct(c.weight, totalWeight)}% of the score
                  </span>
                </div>
                <div className="bg-surface-raised mt-1.5 h-1.5 overflow-hidden rounded-full">
                  <div className="bg-brand h-full rounded-full" style={{ width: `${pct(c.weight, totalWeight)}%` }} />
                </div>
                <p className="text-muted mt-1.5 text-xs">{c.body}</p>
              </div>
            ))}
          </CardBody>
        </Card>

        <p className="text-body text-sm">
          The score then decides the <Term>band</Term>, which is the shorthand everyone uses:
        </p>
        <div className="flex flex-wrap gap-2">
          {[
            ['P1', `${cfg.bands.P1} and above`, 'Work these first'],
            ['P2', `${cfg.bands.P2}–${cfg.bands.P1 - 1}`, 'Work these next'],
            ['P3', `${cfg.bands.P3}–${cfg.bands.P2 - 1}`, 'Worth a look'],
            ['P4', `below ${cfg.bands.P3}`, 'Leave alone for now'],
          ].map(([band, range, meaning]) => (
            <div key={band} className="border-border-base bg-surface min-w-40 flex-1 rounded-lg border px-3 py-2">
              <p className="text-foreground text-sm font-bold">{band}</p>
              <p className="text-muted text-[11px] tabular-nums">{range}</p>
              <p className="text-subtle mt-0.5 text-[11px]">{meaning}</p>
            </div>
          ))}
        </div>

        <div className="border-warning/40 bg-warning/10 rounded-lg border px-4 py-3">
          <p className="text-warning text-xs">
            <Term>One rule overrides everything else.</Term> A project that is finished, cancelled or abandoned is
            capped at {cfg.deadPhaseCap} points no matter how large or how well-connected it is. A completed €2bn data
            centre is still not a sale.
          </p>
        </div>

        {scoring.isDefault ? (
          <p className="text-subtle text-xs">
            These are the built-in settings — nobody has changed them yet. They can be edited under Control Center →
            Routing.
          </p>
        ) : (
          <p className="text-subtle text-xs">
            These weights have been customised for this workspace
            {scoring.overridden.length > 0
              ? `, and ${scoring.overridden.map((b) => BU_LABELS[b] ?? b).join(', ')} scores differently again`
              : ''}
            .
          </p>
        )}
      </Step>

      {/* ---------------------------------------------------------------- */}
      <Step n={2} title="Routing — who should deal with it?">
        <p className="text-body text-sm">
          The score says how urgent something is. Routing says <Term>what to do about it</Term>: whether it belongs to
          sales or to marketing, and how quickly.
        </p>
        <p className="text-body text-sm">
          Rules are checked in order and <Term>the first one that matches wins</Term> — so the most specific rules sit
          at the top. A record matching nothing is left unrouted rather than being guessed at.
        </p>

        <Card>
          <CardHeader
            title={`${rules.length} rule${rules.length === 1 ? '' : 's'} in force`}
            subtitle="Checked top to bottom"
          />
          {rules.length === 0 ? (
            <CardBody>
              <p className="text-muted text-xs">
                No routing rules are active, so nothing is being sorted into lanes at all.
              </p>
            </CardBody>
          ) : (
            <ul className="divide-border-base divide-y">
              {rules.map((r, i) => (
                <li key={r.name} className="px-5 py-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-subtle text-[11px] tabular-nums">{i + 1}</span>
                    <span className="text-foreground text-[13px] font-semibold">{r.name}</span>
                  </div>
                  <p className="text-muted mt-0.5 text-xs">
                    Goes to <Term>{r.assign.route}</Term>
                    {r.assign.stage ? (
                      <>
                        {' '}
                        as <Term>{r.assign.stage.replace(/_/g, ' ')}</Term>
                      </>
                    ) : null}
                    {r.assign.sla_hours ? `, to be actioned within ${r.assign.sla_hours} hours` : ''}.
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <p className="text-body text-sm">
          The <Term>lane</Term> is the outcome: <Term>Act now</Term> and <Term>Qualify</Term> go to sellers,{' '}
          <Term>Nurture</Term> goes to marketing, and <Term>Hold</Term> or <Term>Disqualify</Term> stop there.
        </p>
      </Step>

      {/* ---------------------------------------------------------------- */}
      <Step n={3} title="Enrichment — finding someone to call">
        <p className="text-body text-sm">
          Most records arrive with a project but no people. Enrichment fills that gap: it looks the company up, finds
          the right people, and checks their details are real.
        </p>
        <p className="text-body text-sm">
          It is not run on everything, because every lookup costs money. Records are queued in score order and only the
          top {policy.batchSize} are worked at a time, up to {policy.maxBatchSize} in one run.
        </p>

        <Card>
          <CardHeader title="What enrichment is allowed to do here" />
          <CardBody>
            <dl className="space-y-3">
              {[
                [
                  'Which bands qualify',
                  policy.bands.length ? policy.bands.join(', ') : 'all of them',
                  'Anything outside these is never enriched, however interesting it looks.',
                ],
                [
                  'Who it looks for',
                  policy.contactSeniorities?.length
                    ? policy.contactSeniorities.join(', ')
                    : 'any seniority',
                  'Junior titles are skipped — they cannot authorise a purchase.',
                ],
                [
                  'How many people per company',
                  policy.fillCommittee
                    ? policy.committeeSize === 'enterprise'
                      ? 'eight — two each of the economic buyer, the operational owner, the champion and the end user'
                      : 'four — one each of the economic buyer, the operational owner, the champion and the end user'
                    : 'one primary contact',
                  'A buying decision involves several people, so we look for the group, not one name.',
                ],
                [
                  'What must be found before a lead can move on',
                  Object.entries(policy.channelRules ?? {})
                    .map(([lane, ch]) => `${lane.replace(/_/g, ' ')}: ${ch}`)
                    .join(' · ') || 'nothing required',
                  'A lead only leaves enrichment once it carries what its lane is worked through.',
                ],
                [
                  'Spending limit',
                  policy.monthlyCap ? `${policy.monthlyCap.toLocaleString()} records a month` : 'no monthly limit set',
                  'A ceiling so a misconfigured run cannot spend without bound.',
                ],
              ].map(([label, value, note]) => (
                <div key={label as string}>
                  <dt className="text-foreground text-[13px] font-semibold">{label as string}</dt>
                  <dd className="text-body mt-0.5 text-xs">{value as string}</dd>
                  <dd className="text-subtle text-[11px]">{note as string}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>

        <div className="border-border-base bg-surface-raised rounded-lg border px-4 py-3">
          <p className="text-body text-xs">
            <Term>Why a lead can sit in the queue for a long time.</Term> If its lane requires a phone number and no
            phone can be found, it stays put. That is deliberate — it is not ready to be worked — but it is also the
            most common reason a queue stops moving.
          </p>
        </div>
      </Step>

      {/* ---------------------------------------------------------------- */}
      <Step n={4} title="Assignment — whose lead is it?">
        <p className="text-body text-sm">
          Only enriched leads are handed out. Assignment answers two separate questions: <Term>who is eligible</Term>,
          and <Term>what today&rsquo;s leads should look like as a whole</Term>.
        </p>

        <Card>
          <CardHeader
            title={`${activeAssignment.length} assignment rule${activeAssignment.length === 1 ? '' : 's'}`}
            subtitle="Checked in priority order — the first match wins"
          />
          {activeAssignment.length === 0 ? (
            <CardBody>
              <p className="text-muted text-xs">
                No rules are active, so nothing is being handed out and every lead stays in the unassigned pool.
              </p>
            </CardBody>
          ) : (
            <ul className="divide-border-base divide-y">
              {activeAssignment.map((r) => (
                <li key={r.id} className="px-5 py-3">
                  <p className="text-foreground text-[13px] font-semibold">{r.name}</p>
                  <p className="text-muted mt-0.5 text-xs">
                    Goes to{' '}
                    <Term>
                      {r.toUserId
                        ? (receiving.find((p) => p.id === r.toUserId)?.name ?? 'a specific person')
                        : r.toRole
                          ? `whoever is a ${r.toRole.toUpperCase()} with capacity`
                          : 'nobody — this rule cannot place a lead'}
                    </Term>
                    .
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Capacity" subtitle="Nobody is given more than they can work" />
          <CardBody>
            <p className="text-body text-xs">
              {receiving.length === 0
                ? 'Nobody is on the roster, so no lead can be assigned to anyone.'
                : `${receiving.length} ${receiving.length === 1 ? 'person is' : 'people are'} receiving leads, ${capacity.toLocaleString()} a day between them. Once someone reaches their own daily limit they are skipped until tomorrow.`}
            </p>
            <p className="text-body mt-3 text-xs">
              Two other limits apply to a person: the <Term>business units and regions</Term> they cover, and any{' '}
              <Term>sectors they specialise in</Term>. Both are hard — a lead outside them is never given to that
              person, even if nobody else is free.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="The daily mix" subtitle="What stops one sector taking the whole day" />
          <CardBody>
            <p className="text-body text-xs">{describeAllocation(allocation.policy)}</p>
            {allocation.isDefault ? (
              <p className="text-subtle mt-2 text-[11px]">
                Nobody has set a mix, so leads are handed out strictly best-score-first. That sounds fair and is not:
                whichever sector happens to score highest can take an entire day, while accounts someone was building
                go untouched.
              </p>
            ) : null}
          </CardBody>
        </Card>
      </Step>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-12">
        <h2 className="text-foreground text-lg font-bold">If something looks wrong</h2>
        <p className="text-body mt-2 text-sm">
          Because each stage feeds the next, an empty result is almost never a problem with the stage you are looking
          at. Work backwards:
        </p>
        <ul className="text-body mt-3 space-y-2 text-sm">
          {[
            ['Nothing to call', 'nothing was assigned — check the rules reach a real person with capacity'],
            ['Nothing assigned', 'nothing finished enrichment — check what its lane requires it to find'],
            ['Nothing enriched', 'nothing was queued, or the monthly limit is reached'],
            ['Nothing queued', 'nothing was routed into a sales lane'],
            ['Nothing routed', 'no routing rule matched, or nothing has been scored'],
          ].map(([symptom, cause]) => (
            <li key={symptom} className="flex flex-wrap gap-2">
              <span className="text-foreground min-w-40 font-semibold">{symptom}</span>
              <span className="text-muted flex-1">→ {cause}</span>
            </li>
          ))}
        </ul>
        <p className="text-subtle mt-4 text-xs">
          Team &amp; Users has a checklist that runs these checks against live numbers and shows which link is broken.
        </p>
      </section>
    </div>
  );
}
