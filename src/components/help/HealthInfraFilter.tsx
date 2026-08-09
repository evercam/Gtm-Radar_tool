import HelpToggle from '@/components/help/HelpToggle';
import { WORK_LABEL } from '@/lib/healthInfra';

/**
 * Why the NHS queue contains what it contains.
 *
 * This section exists because the filter behind it makes decisions a seller will
 * disagree with, and being unable to see the reasoning is what turns a
 * disagreement into distrust. Two questions get asked in particular: "why is
 * there so little of it" — 188 health notices over six months yielded about
 * thirty builds — and "why is this £45m contract missing", where the honest
 * answer is that it was manned guarding that mentioned its CCTV.
 *
 * Written to be argued with. Each toggle names the trade-off and the number
 * behind it, so somebody who wants the opposite setting can say so precisely
 * rather than just reporting that the queue "feels wrong".
 */

function Term({ children }: { children: React.ReactNode }) {
  return <span className="text-foreground font-semibold">{children}</span>;
}

/** The kinds that reach the queue, in the order a build actually happens. */
const KEPT: [keyof typeof WORK_LABEL, string][] = [
  ['new_build', 'A new hospital, a wing, a redevelopment, a development agreement.'],
  ['demolition', 'Demolition, asbestos removal, strip-out, decant — the work that clears the way.'],
  ['refurbishment', 'Wards, departments, theatres. The commonest kind by far.'],
  ['building_services', 'Ventilation, boilers, substations, standby power, solar. The plant inside the building.'],
  ['fabric', 'Roofs, windows, cladding, flooring, fire alarms, access control.'],
];

const SET_ASIDE: [keyof typeof WORK_LABEL, string][] = [
  ['survey_design', 'Condition surveys, feasibility studies, planning applications, design teams, cost consultancy.'],
  ['maintenance', 'Backlog and planned maintenance, servicing contracts.'],
];

export default function HealthInfraFilter() {
  return (
    <section className="mt-12">
      <h2 className="text-foreground text-lg font-bold">Where the NHS leads come from</h2>
      <p className="text-body mt-2 text-sm">
        Two UK government feeds — <Term>Find a Tender</Term> and <Term>Contracts Finder</Term> — publish every public
        contract above a threshold, and NHS trusts own a great deal of estate. The difficulty is that a trust also buys
        nurse rotas, hip implants, Microsoft licences and taxis from the same feeds, and building work is a very thin
        slice of it: over six months, 188 notices came from a health buyer and roughly thirty were construction.
      </p>

      <div className="mt-4 space-y-2">
        <HelpToggle question="Why not just search for “NHS”?">
          <p>
            Because the word is almost never in the notice. It is in the <Term>buyer&rsquo;s name</Term> — “Mid and South
            Essex NHS Foundation Trust” — and not in the title or the description of what is being bought. In a sample of
            100 notices, 13 came from an NHS body and only <Term>3</Term> said so anywhere in their text.
          </p>
          <p>
            So the filter reads the procuring organisation, not the words of the advert. A plain keyword search for “NHS”
            would quietly miss about three quarters of them, and look like it was working.
          </p>
        </HelpToggle>

        <HelpToggle question="Why not just search for “construction”?">
          <p>
            It was tried, and it fails in both directions on health procurement. The words that normally identify a build
            pick up <Term>“Microsoft Infrastructure Software Licensing”</Term>, <Term>“Enterprise Network
            Infrastructure”</Term> and <Term>“Legal Services — Property &amp; Construction”</Term>, while having nothing
            that recognises asbestos removal or a ward refurbishment.
          </p>
          <p>
            The usual answer is to use the notice&rsquo;s CPV classification code instead, which would settle it
            immediately. Measured over 500 notices from each publisher: Find a Tender carries a code on{' '}
            <Term>4%</Term> of notices and Contracts Finder on <Term>none at all</Term>. There is nothing to lean on but
            the wording, so this source has its own vocabulary, and exclusions are checked first — a contract that
            mentions software licensing is not a building project however many times it says infrastructure.
          </p>
        </HelpToggle>

        <HelpToggle question="What counts as construction here?">
          <p>Work where something is physically built, altered or removed:</p>
          <ul className="mt-1 space-y-1">
            {KEPT.map(([kind, what]) => (
              <li key={kind} className="flex flex-wrap gap-x-2">
                <span className="text-foreground font-semibold">{WORK_LABEL[kind].replace('Healthcare — ', '')}</span>
                <span className="text-muted">{what}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2">
            Each lead carries its kind in <Term>building type</Term>, so the queue can be sorted by it.
          </p>
        </HelpToggle>

        <HelpToggle question="Why are surveys and maintenance not in the queue?">
          <p>Because they are real estates spend but nobody is building anything yet:</p>
          <ul className="mt-1 space-y-1">
            {SET_ASIDE.map(([kind, what]) => (
              <li key={kind} className="flex flex-wrap gap-x-2">
                <span className="text-foreground font-semibold">{WORK_LABEL[kind].replace('Healthcare — ', '')}</span>
                <span className="text-muted">{what}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2">
            They are still recognised and labelled, just held back — a condition survey today is often a refurbishment
            next year, so this is a queue that could be opened up deliberately rather than a category that was thrown
            away. Say so if you want it.
          </p>
          <p>
            One consequence worth knowing: an appointment to <em>advise</em> on a trade is filed as advice, not as the
            trade. “M&amp;E Engineer Led Design Team” and “Consultancy Service For Flat Roof Replacement” are design
            appointments, not M&amp;E and roofing jobs.
          </p>
        </HelpToggle>

        <HelpToggle question="Something obvious is missing. Why?">
          <p>
            The filter is deliberately tuned to be <Term>strict rather than generous</Term>. Titles like “Kinnaird House
            Proposed Work” are genuine estates jobs that it drops, because the words loose enough to catch them also
            catch a dozen clinical contracts.
          </p>
          <p>
            That trade is made on purpose. A missed lead costs one lead. A queue with three nursing-agency contracts in
            it costs the queue its credibility, and after that nobody opens it. If you find a real build that was
            dropped, it is worth reporting — the vocabulary is a list, and adding a phrase to it is a small change.
          </p>
        </HelpToggle>

        <HelpToggle question="Is this everything the NHS has published?">
          <p>
            No, and it is worth being precise about why. Both publishers throttle at{' '}
            <Term>12 requests every 120 seconds</Term>, which is not documented anywhere — it was found by hitting it. A
            full sweep therefore runs at one page per ten seconds, roughly four minutes per thousand notices read.
          </p>
          <p>
            So a pull covers a stated window — by default the last 180 days — rather than everything ever published, and
            it walks that window a month at a time. If a month cannot be read, the run says so explicitly instead of
            reporting a total that looks complete.
          </p>
        </HelpToggle>
      </div>
    </section>
  );
}
