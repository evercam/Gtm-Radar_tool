import { Card, CardBody, CardHeader, Badge } from '@/components/ui';

/**
 * How to read a source's API limits, and what to do with them.
 *
 * Written because every source was fetching fifty records a run while permitting
 * five hundred, and one of them permits fifty thousand in a single request. That
 * gap was invisible: nothing in the tool showed what a vendor allows next to what
 * we ask for, so nobody could see that we were paying full price per request for
 * a fraction of the payload.
 *
 * The table separates what has been READ IN THE VENDOR'S DOCUMENTATION from what
 * is still assumed from our own code. That distinction is the point — an assumed
 * limit is a guess wearing a number's clothes, and acting on one is how you get
 * throttled or silently truncated.
 */

function Term({ children }: { children: React.ReactNode }) {
  return <span className="text-foreground font-semibold">{children}</span>;
}

/** What we know about one vendor's API, and how confident we are. */
interface SourceLimit {
  name: string;
  /** Records one request may return. */
  perRequest: string;
  /** How you walk to the next page. */
  paging: string;
  /** Hard ceilings beyond the page — total window, date span, rate. */
  ceiling: string;
  verified: boolean;
  doc?: string;
}

const LIMITS: SourceLimit[] = [
  {
    name: 'SAM.gov',
    perRequest: '1,000',
    paging: 'offset, from 0',
    ceiling: 'date range max ONE YEAR; postedFrom and postedTo both mandatory',
    verified: true,
    doc: 'https://open.gsa.gov/api/get-opportunities-public-api/',
  },
  {
    name: 'Socrata (NYC + Chicago permits)',
    perRequest: '50,000',
    paging: '$offset with $limit',
    ceiling: 'an app token raises throttling to 1,000 requests an hour; without one it is much lower',
    verified: true,
    doc: 'https://dev.socrata.com/docs/app-tokens.html',
  },
  {
    name: 'SEC EDGAR full-text search',
    perRequest: '100 — fixed, no size parameter is honoured',
    paging: 'from, stepping by 100',
    ceiling:
      'TOTAL result window 10,000, so from cannot exceed 9,900 — past that it answers HTTP 200 with an error body. 10 requests a second. A User-Agent identifying the caller is required.',
    verified: true,
    doc: 'https://www.sec.gov/edgar/search/efts-faq.html',
  },
  {
    name: 'OCDS feeds (Find a Tender, Contracts Finder)',
    perRequest: 'publisher’s choice — the standard sets none',
    paging: 'follow links.next; cursor or since preferred over offset',
    ceiling:
      'the standard warns that with offset paging "a given page won’t return the same results over time" — which is why it prefers a cursor. Contracts Finder documents no numeric limits at all.',
    verified: true,
    doc: 'https://standard.open-contracting.org/latest/en/guidance/build/hosting/',
  },
  {
    name: 'TED (EU tenders)',
    perRequest: '250',
    paging: 'page number',
    ceiling:
      'rejects sort parameters, and returns OLDEST FIRST inside whatever window it is given — so an unbounded query answers from 2016, not from today',
    verified: false,
  },
  { name: 'USAspending', perRequest: '100 (assumed)', paging: 'page number', ceiling: 'not checked', verified: false },
  { name: 'World Bank', perRequest: '20 (assumed)', paging: 'offset', ceiling: 'not checked — 20 looks low enough to be a mistake', verified: false },
  { name: 'Planning.ie (ArcGIS)', perRequest: '200 (assumed)', paging: 'resultOffset', ceiling: 'ArcGIS services publish their own maxRecordCount — worth reading', verified: false },
  { name: 'Glenigan', perRequest: '50 (assumed)', paging: 'page number', ceiling: 'commercial — check the contract, not the docs', verified: false },
];

export default function SourceLimits() {
  return (
    <section className="mt-12">
      <h2 className="text-foreground text-lg font-bold">Reading a source’s limits</h2>
      <p className="text-body mt-2 text-sm">
        Every source has a ceiling, and it is never one number. Getting the most out of one means knowing which of three
        different ceilings you are actually hitting — and they fail in completely different ways.
      </p>

      <div className="mt-4 space-y-3">
        {[
          [
            'How many per request',
            'The vendor’s page size. A request for 50 costs exactly the same as a request for their maximum, so asking small is paying full price for a fraction of the payload. This is almost always the cheapest thing to fix.',
          ],
          [
            'How many per run',
            'Our own budget — how many pages we are willing to walk in one go. Independent of the vendor. Too low and we leave data behind; too high and one source eats the whole scheduled window.',
          ],
          [
            'How many exist to be had',
            'The one people miss. Some APIs cap the TOTAL result set regardless of paging — EDGAR stops dead at ten thousand however patiently you page. Past that the only way through is a narrower query, usually a tighter date window, stitched together.',
          ],
        ].map(([label, body]) => (
          <div key={label} className="border-border-base bg-surface-raised rounded-lg border px-4 py-3">
            <p className="text-foreground text-[13px] font-semibold">{label}</p>
            <p className="text-body mt-1 text-xs leading-relaxed">{body}</p>
          </div>
        ))}
      </div>

      <h3 className="text-foreground mt-8 text-[13px] font-bold uppercase tracking-wide">What each source allows</h3>
      <p className="text-subtle mt-1 text-xs">
        Read from the vendor’s own documentation where marked. The rest are what our adapter currently assumes, which is
        not the same thing as what the vendor permits — an assumed limit is a guess with a number on it.
      </p>

      <div className="mt-3 space-y-3">
        {LIMITS.map((l) => (
          <Card key={l.name}>
            <CardHeader
              title={l.name}
              subtitle={`${l.perRequest} per request · ${l.paging}`}
              action={l.verified ? <Badge tone="success">documented</Badge> : <Badge tone="warning">assumed</Badge>}
            />
            <CardBody>
              <p className="text-body text-xs leading-relaxed">{l.ceiling}</p>
              {l.doc ? (
                <a
                  href={l.doc}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand mt-2 inline-block text-[11px] underline underline-offset-2"
                >
                  vendor documentation →
                </a>
              ) : null}
            </CardBody>
          </Card>
        ))}
      </div>

      <h3 className="text-foreground mt-8 text-[13px] font-bold uppercase tracking-wide">
        Adding or tuning a source, in order
      </h3>
      <ol className="mt-3 space-y-3">
        {[
          [
            'Read the docs before touching anything',
            'Find the three ceilings and the paging style. Ten minutes here saves discovering a total-result cap by watching a run truncate silently at a suspiciously round number.',
          ],
          [
            'Match the request size to their maximum',
            'The single highest-value change, and free. One source here permits fifty thousand a request and we ask for two hundred.',
          ],
          [
            'Prefer a cursor over an offset',
            'Where a vendor offers both. With offsets, a record published mid-pull shifts every page after it — you re-read some rows and never see others. A cursor is anchored to a row, so it cannot drift. The contracting standard says this explicitly and it is true of every paged API.',
          ],
          [
            'Use dates as the real lever',
            'A total-result cap cannot be paged around, only queried around. Narrower windows, stitched: last week, the week before, and so on. This is also what keeps a run cheap — asking for what changed since yesterday beats asking for everything and discarding most of it.',
          ],
          [
            'Get a token if one raises the limits',
            'Sometimes throttling is generous with a free token and mean without. Socrata gives a thousand requests an hour for registering.',
          ],
          [
            'Only then reach for more queries',
            'More keyword and sector combinations reach different SLICES of an index. That is a coverage problem and worth solving — but not before the depth problem, or each variation just truncates at the same shallow ceiling.',
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

      <div className="border-border-base bg-surface-raised mt-5 rounded-lg border px-4 py-3">
        <p className="text-body text-xs leading-relaxed">
          <Term>Fetching more never risks duplicates.</Term> A record is identified by the id its own source gave it.
          Repeats inside one batch collapse before writing, repeats across runs update the existing row rather than adding
          another, and the same project arriving from two different sources is rare enough to have been measured at two
          records in twenty-two thousand. Depth is safe; the thing to watch is a vendor that re-serves rows it has already
          given, which wastes requests rather than corrupting anything.
        </p>
      </div>
    </section>
  );
}
