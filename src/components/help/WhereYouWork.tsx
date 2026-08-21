import Link from 'next/link';
import { Card, CardBody, CardHeader } from '@/components/ui';

/**
 * Where the operator surfaces are, and what each one is for.
 *
 * This page explained in detail how the machine DECIDES — scoring, routing,
 * enrichment, assignment, export — and never once said where a person goes to
 * change any of it. Nothing on it mentioned Operations, the Source Hub, or
 * Administration. Somebody who read the whole thing still had to guess which of
 * eleven pages held the dial they wanted.
 *
 * Grouped the way the rail is, because that is the split the app is built along:
 * Operations is the daily loop and changes constantly; Administration is setup
 * that rarely changes and is dangerous next to a button pressed every morning.
 *
 * Every page here is permission-gated, so a reader will not necessarily see all of
 * them. Said once at the end rather than hedged on every line.
 */

function Surface({
  href,
  name,
  what,
  when,
}: {
  href: string;
  name: string;
  what: string;
  /** The question that sends someone here. More useful than a feature list. */
  when: string;
}) {
  return (
    <div className="border-border-base flex flex-col gap-1 border-b py-3 last:border-0 sm:flex-row sm:gap-4">
      <Link
        href={href}
        className="text-brand w-40 shrink-0 text-[12px] font-semibold underline underline-offset-2"
      >
        {name}
      </Link>
      <div className="min-w-0">
        <p className="text-body text-xs leading-relaxed">{what}</p>
        <p className="text-subtle mt-0.5 text-[11px] leading-relaxed">{when}</p>
      </div>
    </div>
  );
}

export default function WhereYouWork() {
  return (
    <section className="mt-10">
      <h2 className="text-foreground text-lg font-bold">Where you do it</h2>
      <p className="text-muted mt-1 max-w-3xl text-sm">
        Everything above happens on a schedule without anyone asking. These are the places you change what it does, or
        find out what it did.
      </p>

      <Card className="mt-3">
        <CardHeader
          title="Operations"
          subtitle="The daily loop — find, enrich, route, distribute. Reached from Operations in the sidebar, which opens its pages on hover."
        />
        <CardBody className="py-0">
          <Surface
            href="/control"
            name="Overview"
            what="The state of the machine in one screen: what ran, what is queued, what failed."
            when="Start here when something feels wrong and you do not yet know what."
          />
          <Surface
            href="/control/sources"
            name="Source Hub"
            what="Every publisher the tool can read, whether it is switched on, when it last delivered and how much it gave. Also where a source is searched by hand."
            when="“Why do we have no leads in the UK?” — this answers it before you assume the pipeline is broken."
          />
          <Surface
            href="/control/enrichment"
            name="Enrichment"
            what="The queue of leads waiting for a contact, the policy that decides which ones qualify, and the spend rails."
            when="When people are idle and you need to know whether the tank is empty or the policy is too narrow."
          />
          <Surface
            href="/control/routing"
            name="Routing"
            what="The rules that turn a score into a lane, the scoring weights behind the score, and a preview of what a change would do before it is applied."
            when="When leads are landing on the wrong desk, or the top of the queue stops being useful."
          />
          <Surface
            href="/control/exports"
            name="Export History"
            what="Every send to Apollo, what went in it, and what came back."
            when="“Did that lead actually reach Apollo, and when?” — Apollo raises no notification, so this is the only answer."
          />
          <Surface
            href="/control/logs"
            name="Activity Log"
            what="What each scheduled run did, in order, including the ones that failed and why."
            when="After a quiet morning, to see whether a run was skipped, timed out, or simply found nothing."
          />
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHeader
          title="Administration"
          subtitle="Setup that rarely changes. Separate from Operations on purpose — these are not buttons to press while working a list."
        />
        <CardBody className="py-0">
          <Surface
            href="/admin/settings"
            name="Settings"
            what="API keys, credentials, the enrichment and scoring policies, sign-in domains."
            when="Once, when connecting something — and then rarely."
          />
          <Surface
            href="/admin/team"
            name="Team & Users"
            what="Who is on the roster, their daily quota, the scope of business units and verticals each person can be given, and who holds which role."
            when="When somebody has no work and the queue is full: a lead nobody's scope covers cannot be assigned at any quota."
          />
          <Surface
            href="/admin/costs"
            name="Cost"
            what="What enrichment has spent, against the month's budget."
            when="Before raising a target, and after a run that felt expensive."
          />
        </CardBody>
      </Card>

      <div className="border-border-base bg-surface-raised mt-4 rounded-lg border px-4 py-3">
        <p className="text-body text-xs leading-relaxed">
          Each of these pages checks its own permission, so you will only see the ones your role allows — and the
          sidebar hides the rest rather than offering a link that refuses. If a page you expect is missing, that is a
          role question for an administrator, not a bug.
        </p>
      </div>
    </section>
  );
}
