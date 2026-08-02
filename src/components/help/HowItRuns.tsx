import { Card, CardBody, CardHeader } from '@/components/ui';

/**
 * How the machine runs itself — the operational half of the help page.
 *
 * The rest of that page explains what each stage DECIDES. This explains when
 * anything happens at all, and why the throughput is what it is. Both questions
 * get asked, and only the first one had an answer.
 *
 * Deliberately free of settings. Numbers change; the reasoning does not, and a
 * page that lists current values teaches somebody to read the settings screen
 * rather than to understand the machine. Where a figure appears here it is a
 * measured property of the platform — how long a function may live, how long a
 * record takes — not something anybody configured.
 */

function Term({ children }: { children: React.ReactNode }) {
  return <span className="text-foreground font-semibold">{children}</span>;
}

function Row({ when, what, why }: { when: string; what: string; why: string }) {
  return (
    <div className="border-border-base grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 border-t py-3 first:border-t-0 first:pt-0">
      <div className="text-foreground font-mono text-[11px] font-semibold">{when}</div>
      <div>
        <p className="text-foreground text-[13px] font-semibold">{what}</p>
        <p className="text-muted mt-0.5 text-xs leading-relaxed">{why}</p>
      </div>
    </div>
  );
}

export default function HowItRuns() {
  return (
    <>
      <section className="mt-12">
        <h2 className="text-foreground text-lg font-bold">The whole journey of one record</h2>
        <p className="text-body mt-2 text-sm">
          Nothing here is triggered by a person. A record enters at the top and moves down on its own, one stage per
          run, and each stage refuses to start until the one before it has produced something to work with.
        </p>

        <ol className="mt-4 space-y-3">
          {[
            [
              'It arrives',
              'A source publishes a project — a power station, a tender, a permit — and we copy it in. The same project from two sources becomes one record, not two, matched on the identifier its source gave it.',
            ],
            [
              'It gets a score',
              'Six things are measured and added up: how close it is to breaking ground, how big it is, whether it is the kind of company we sell to, whether anyone is reachable, whether the account matters, and how recent it is. This is the only stage that touches every record.',
            ],
            [
              'It gets a lane',
              'The score and the record’s own facts decide whether it belongs to sales, marketing, or nobody — and how urgently. Most records end here, in a lane that means "not now". That is the system working, not failing.',
            ],
            [
              'It gets people',
              'Only records in a sales lane. We resolve the company to a real business, find the people who would sign or use the thing being built, and reveal contact details for as many as the spend allows. This is the only stage that costs money per record, and the only one with a ceiling on how much it may do.',
            ],
            [
              'It gets a briefing',
              'What the company is, what is happening there, and the single strongest thing to open with. Separate from the previous stage because it runs on a different clock — see below.',
            ],
            [
              'It gets an owner',
              'Assigned to whoever covers that sector and region and has room left today. Never to somebody who cannot work it, and never beyond their daily limit.',
            ],
            [
              'It leaves',
              'Sent to Apollo, where the seller actually works. At that moment it is archived: out of the queue, never enriched again, no longer counted as stock. Nothing is deleted — it is simply somebody else’s job now.',
            ],
          ].map(([title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className="bg-surface-raised border-border-base text-subtle mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold">
                {i + 1}
              </span>
              <div>
                <p className="text-foreground text-[13px] font-semibold">{title}</p>
                <p className="text-body mt-0.5 text-xs leading-relaxed">{body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="border-border-base bg-surface-raised mt-4 rounded-lg border px-4 py-3">
          <p className="text-body text-xs leading-relaxed">
            <Term>Each stage is a filter, so an empty result is normal.</Term> Twenty-three thousand records in, a few
            hundred a day out. The narrowing is the point — the alternative is a seller working a list of power stations
            that were finished in 2019.
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-12">
        <h2 className="text-foreground text-lg font-bold">When anything actually happens</h2>
        <p className="text-body mt-2 text-sm">
          Two schedulers, because one of them cannot run often enough on its own.
        </p>

        <Card className="mt-4">
          <CardHeader title="Every hour" subtitle="The part that has to keep up" />
          <CardBody>
            <Row
              when="on the hour"
              what="Find people for the next batch of records"
              why="The expensive stage, and the one the whole month's supply depends on. Runs constantly rather than once, because one run cannot produce a day's worth."
            />
            <Row
              when="half past"
              what="Brief whatever the hour produced"
              why="Deliberately after, not during. A briefing needs the contacts to exist first, and putting the two in one run made the run too long to finish."
            />
          </CardBody>
        </Card>

        <Card className="mt-3">
          <CardHeader title="Once a day, early" subtitle="The parts that only need doing once" />
          <CardBody>
            <Row
              when="06:00"
              what="Pull from every source, score everything new, put it in a lane"
              why="Sources publish overnight at best. Checking hourly would find nothing new and cost a request each time."
            />
            <Row
              when="06:00"
              what="Hand out owners, then send the day's leads"
              why="A seller wants a list when they sit down, not a trickle through the afternoon. Everything the night produced arrives at once."
            />
          </CardBody>
        </Card>

        <div className="border-border-base bg-surface-raised mt-4 rounded-lg border px-4 py-3">
          <p className="text-body text-xs leading-relaxed">
            <Term>A missed hour costs nothing.</Term> The target is a monthly total, not an hourly quota, so a run that
            does not fire is made up by the next one. Runs never overlap either — two at once would find the same
            records and pay for them twice.
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-12">
        <h2 className="text-foreground text-lg font-bold">How much it can do, and why</h2>

        <p className="text-body mt-2 text-sm">
          Every run happens inside a request that the hosting platform will cut off after{' '}
          <Term>five minutes</Term>, whatever it is doing. That single constraint shapes everything else.
        </p>

        <ul className="text-body mt-3 space-y-2 text-sm">
          <li className="flex gap-2">
            <span className="text-subtle mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current" />
            <span>
              Finding people for one record takes a handful of seconds — several lookups against an outside service, one
              after another. So a single run gets through roughly <Term>seventeen records</Term>, and stops well short
              of the cut-off so a slow one cannot take the whole batch down with it.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-subtle mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current" />
            <span>
              Seventeen an hour, around the clock, is a few hundred a day. That is what makes the monthly number
              reachable — and it is why this runs hourly rather than once a day. Once a day produced about four percent
              of what the team needs.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-subtle mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current" />
            <span>
              Research about a <Term>company</Term> is done once and kept, not repeated for each of its projects. One
              owner can hold hundreds of records; asking the same question hundreds of times is the difference between
              affordable and not.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-subtle mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current" />
            <span>
              The same applies to <Term>people</Term>. Once we have paid to reveal someone&rsquo;s details, every later
              record at that company gets them free. Sibling projects at one owner cost almost nothing after the first.
            </span>
          </li>
        </ul>

        <Card className="mt-4">
          <CardHeader title="When it stops" subtitle="Producing is not the goal — supplying the team is" />
          <CardBody>
            <p className="text-body text-xs leading-relaxed">
              There is a number of leads to make each month, worked out from what the team consumes. Enrichment runs
              until that number is made and then <Term>stops</Term>, and every run after it returns quietly without
              spending anything. It starts again on the first of the month.
            </p>
            <p className="text-body mt-3 text-xs leading-relaxed">
              This is a <Term>rate</Term>, not a shelf. A rule that said &ldquo;hold this many in stock&rdquo; would stop
              producing the moment the shelf looked full, and never account for what had been taken off it. Counting
              what is made in a month keeps supply level with demand instead.
            </p>
          </CardBody>
        </Card>

        <Card className="mt-3">
          <CardHeader title="Who the batch is for" subtitle="Not simply the highest scores" />
          <CardBody>
            <p className="text-body text-xs leading-relaxed">
              Each person&rsquo;s share of the month is their daily limit&rsquo;s share of the team&rsquo;s. Every run
              looks at who is <Term>furthest from their share</Term> and produces for them, in proportion. Score still
              decides which record within a person, so nothing weaker gets through — but someone covering one narrow
              sector is never crowded out by a bigger colleague&rsquo;s stronger leads.
            </p>
            <p className="text-body mt-3 text-xs leading-relaxed">
              If nothing can be found for somebody — their sector genuinely has no live projects — the run{' '}
              <Term>says their name</Term> rather than quietly topping up everyone else. An empty queue for one person
              is a sourcing problem, and it looks identical to a healthy month unless something reports it.
            </p>
          </CardBody>
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-12">
        <h2 className="text-foreground text-lg font-bold">Two things that surprise people</h2>

        <div className="mt-3 space-y-3">
          <div className="border-border-base bg-surface-raised rounded-lg border px-4 py-3">
            <p className="text-body text-xs leading-relaxed">
              <Term>Scores are written down, not worked out each time you look.</Term> A record carries the score it was
              given when it was last examined. Change how scoring works and nothing moves until every record is examined
              again — until then the rules say one thing and the list shows another, and the queue follows the list.
            </p>
          </div>
          <div className="border-border-base bg-surface-raised rounded-lg border px-4 py-3">
            <p className="text-body text-xs leading-relaxed">
              <Term>A run that does nothing is usually correct.</Term> The month&rsquo;s number is already made, or
              there was nothing eligible. Both are reported as success with a reason, because a scheduled job that cries
              failure for working properly teaches everybody to ignore it — and then the real failure goes unnoticed
              too.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
