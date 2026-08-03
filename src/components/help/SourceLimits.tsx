import { Badge, Table, TableShell, THead, TBody, Th, Td } from '@/components/ui';
import { API_LIMITS } from '@/lib/sources/apiLimits';

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

      <div className="mt-3">
        <TableShell>
          <Table>
          <THead>
            <tr>
              <Th>Source</Th>
              <Th align="right">Per request</Th>
              <Th align="right">We ask</Th>
              <Th>Paging</Th>
              <Th align="right">Total cap</Th>
              <Th>Confidence</Th>
            </tr>
          </THead>
          <TBody>
            {API_LIMITS.map((l) => (
              <tr key={l.label}>
                <Td className="text-foreground font-medium">
                  {l.label}
                  <div className="text-body mt-0.5 max-w-md text-[11px] leading-relaxed font-normal">{l.note}</div>
                  {l.doc ? (
                    <a
                      href={l.doc}
                      target="_blank"
                      rel="noreferrer"
                      className="text-brand mt-1 inline-block text-[10px] underline underline-offset-2"
                    >
                      documentation →
                    </a>
                  ) : null}
                </Td>
                <Td align="right" className="text-foreground tabular-nums">
                  {l.maxPerRequest.toLocaleString()}
                </Td>
                <Td align="right" className="text-muted tabular-nums">
                  {l.recommendedPageSize.toLocaleString()}
                </Td>
                <Td className="text-muted text-[11px]">{l.paging}</Td>
                <Td align="right" className="tabular-nums">
                  {l.maxTotalResults ? (
                    <span className="text-warning">{l.maxTotalResults.toLocaleString()}</span>
                  ) : (
                    <span className="text-subtle">none</span>
                  )}
                </Td>
                <Td>
                  <Badge tone={l.verified ? 'success' : 'warning'}>{l.verified ? 'documented' : 'assumed'}</Badge>
                </Td>
              </tr>
            ))}
          </TBody>
          </Table>
        </TableShell>
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
