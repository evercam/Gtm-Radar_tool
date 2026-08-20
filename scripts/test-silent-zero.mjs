/**
 * A failure must not present as a legitimate zero.
 *
 *   node --no-warnings scripts/test-silent-zero.mjs
 *
 * This is the bug class this codebase keeps rediscovering, one surface at a time.
 * `diagnose-sources.mjs` opens with it — "a source that returns nothing looks
 * identical, in the UI, to one that is broken" — and it has since been re-fixed
 * for ready inventory (`readyInventory`'s `unavailable`), for the 24h enriched
 * count ("a count that could not be measured is not a count of zero"), and for
 * starved reps ("an empty result must not look like a full tank").
 *
 * Every one of those was written after an incident. Found on 2026-08-13, in one
 * pass, still live:
 *
 *   the enrichment queue returned { rows: [], total: 0 } on a statement timeout,
 *     so the control centre told a seller there was nothing to call — measured
 *     failing roughly half the time, at 9.1s against a 7.8s success
 *   /api/enrich/batch answered `ok: true, "Nothing in the queue matches the
 *     current policy"` for that same failed read, so the nightly batch enriched
 *     nobody and reported success
 *   rerouteAll broke out of its paging loop on error and returned
 *     `reachedCap: false`, meaning "nothing was cut off" — it had abandoned 613
 *     records, which is why 19,613 sat unscored despite a nightly cron
 *
 * Asserted on source text, like test-queue-filters.mjs, because these are
 * contracts about what the code CANNOT say rather than what it computes. A
 * database mock would test the mock.
 */

import { readFileSync } from 'node:fs';

let passed = 0,
  failed = 0;
const check = (n, c, d) => {
  if (c) {
    passed++;
    console.log(`  PASS ${n}`);
  } else {
    failed++;
    console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`);
  }
};
const group = (n) => console.log(`\n${n}`);

/**
 * Comments stripped, for assertions about CODE.
 *
 * Needed because these comments quote the very patterns being banned — "not
 * `.range()`", "used to be one select(columns, { count: 'exact' })" — so a naive
 * search finds the prohibition and calls it a violation. The first draft of this
 * file failed on its own documentation.
 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
/**
 * Whitespace flattened, for assertions about PROSE that wraps across lines.
 *
 * JSDoc leading asterisks go first. Without that, flattening turns "null is\n * a
 * fact about this request" into "null is * a fact about this request" and a search
 * for the sentence misses it.
 */
const prose = (s) =>
  s
    .replace(/^[ \t]*\*/gm, ' ')
    .replace(/\s+/g, ' ');

const queries = readFileSync('src/lib/queries.ts', 'utf8');
const batch = readFileSync('src/app/api/enrich/batch/route.ts', 'utf8');
const page = readFileSync('src/app/control/enrichment/page.tsx', 'utf8');
const control = readFileSync('src/app/control/page.tsx', 'utf8');
const routing = readFileSync('src/app/api/routing/apply/route.ts', 'utf8');
const demand = readFileSync('src/lib/enrich/demand.ts', 'utf8');
const apolloExport = readFileSync('src/app/api/export/apollo/route.ts', 'utf8');

group('The enrichment queue can say "I failed" instead of "there is nothing"');
{
  const iface = queries.match(/export interface EnrichQueueResult \{[\s\S]*?\n\}/)?.[0] ?? '';
  check('EnrichQueueResult exists', iface.length > 0);
  check('total is nullable, so an unmeasured count is not zero', /total: number \| null/.test(iface), iface.slice(0, 120));
  check('failed distinguishes a dead read from an empty one', /failed: boolean/.test(iface));

  const fn = queries.match(/export async function getEnrichmentQueue[\s\S]*?\n\}/)?.[0] ?? '';
  check('getEnrichmentQueue was found', fn.length > 0);
  // The specific regression: an error path that fabricates a zero count.
  check('no error path returns total: 0', !/total: 0/.test(code(fn)), code(fn).match(/.{0,40}total: 0.{0,40}/)?.[0]);
  check('every failure path sets failed: true', (fn.match(/failed: true/g) ?? []).length >= 2);
  check('the rows query no longer carries an inline exact count', !/select\(columns, \{ count: 'exact' \}\)/.test(code(fn)));
  check('rows and count are read in parallel', /Promise\.all\(\[fetchRows\(\), countTotal\(\)\]\)/.test(fn));
}

group('Callers act on the difference rather than rendering emptiness');
{
  check('the batch endpoint checks fill.failed', /fill\.failed/.test(batch), 'a failed read would report "nothing in the queue"');
  check('and answers ok: false for it', /ok: false,[\s\S]{0,200}could not be read/.test(batch));
  check(
    'its empty-queue message is still reachable for a genuinely empty queue',
    /Nothing in the queue matches the current policy/.test(batch)
  );

  check('the enrichment page has a distinct failed state', /queueFailed/.test(page));
  check('and does not print a null count as a number', /total === null/.test(page));

  /*
    The control page's queue count, guarded at every use.

    This read `/queueTotal === null/` and started failing when the count was
    extracted into `queueTotalOnce()` and the local renamed to `total`. Nothing
    about the contract changed — both call sites still refuse to print an
    unmeasurable count as a number — but the assertion was pinned to a SPELLING
    rather than to the behaviour, so a pure rename read as a regression. That is
    its own kind of silent failure: a test that cries wolf gets muted, and the
    next real break goes with it.

    So it now anchors on the accessor and checks each call site, which survives
    renaming the variable and still fails if a guard is dropped.
  */
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const queueUses = control.split('queueTotalOnce()').slice(1).map((s) => stripComments(s.slice(0, 400)));

  check('the control page reads the queue count', queueUses.length > 0, `${queueUses.length} call sites`);
  check(
    'the control page does not print a null count as a number',
    queueUses.length > 0 && queueUses.every((after) => /===\s*null/.test(after)),
    `${queueUses.filter((a) => !/===\s*null/.test(a)).length} unguarded of ${queueUses.length}`
  );
  check(
    'and never coalesces the queue count to zero',
    !queueUses.some((after) => /\?\?\s*0/.test(after)),
    'a `?? 0` would turn an unmeasurable count into "no work to do"'
  );

  check('demand fill propagates failure', /failed: boolean/.test(demand) && /q\.failed/.test(demand));
  /*
    A failed read used to land in `starved`, which the caller treats as a SOURCING
    problem — go find more records. Wrong department entirely.
  */
  check('and does not let a failed read masquerade as starvation', /must not be reported as starvation/.test(demand));
}

group('The scoring pass cannot abandon its tail and call itself complete');
{
  const fn = queries.match(/export async function rerouteAll[\s\S]*?\n  return \{ total[^\n]*\n/)?.[0] ?? '';
  check('rerouteAll was found', fn.length > 0);
  check('it reports truncation', /truncated/.test(fn));
  check('and returns it to the caller', /truncated \}/.test(fn));
  // The bare `break` on error was the whole bug.
  check('the error path records the reason', /truncated = error\.message/.test(fn));

  /*
    Keyset, not offset. `range(19000, 19999)` re-walks nineteen thousand rows and
    exceeded the statement timeout, which is what silently truncated the pass.
  */
  check('paging is keyset on id', /\.gt\('id', after\)/.test(fn), 'still offset-paged');
  check('and no longer uses .range()', !/\.range\(/.test(code(fn)), code(fn).match(/.{0,30}\.range\(.{0,30}/)?.[0]);
  check('the order by id that makes keyset safe is still there', /order\('id', \{ ascending: true \}\)/.test(fn));

  check('the routing endpoint surfaces a partial pass', /PARTIAL/.test(routing));
  check('and stops claiming success when the read died', /ok: !res\.truncated/.test(routing));
  check(
    'a zero-scored run no longer always reads as "everything already scored"',
    /res\.total === 0 && res\.truncated/.test(routing)
  );
}

group('The Apollo export names every gate it applied, including the cold one');
{
  /*
    The same bug class, one surface further on: an export that sends nothing and
    cannot say why.

    The zero-rows branch counts five reasons out of SQL — assigned, already sent,
    no email, unverified, do-not-contact — and names quota out of memory. The cold
    ARRIVAL gate is the sixth, and it is the only one that cannot be counted in
    SQL: the verdict comes from `arrivalFor` reading the admin-editable phase
    table. It was being counted into `coldSkipped` and then dropped on the floor,
    so a rep whose whole book is mid-build got "Nothing eligible." with an empty
    diagnosis — indistinguishable from a broken export.
  */
  const zeroBranch = apolloExport.match(/if \(rows\.length === 0\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  check('the zero-rows branch was found', zeroBranch.length > 0);
  check('the cold count reaches the prose', /because\.push\(`\$\{coldSkipped\}/.test(zeroBranch));
  check('and reaches the machine-readable breakdown', /cold: coldSkipped/.test(zeroBranch));
  // The point of the count is that it is spent. A counter nothing reads is the
  // filter hiding what it removed all over again.
  check(
    'coldSkipped is read, not just incremented',
    (code(apolloExport).match(/coldSkipped/g) ?? []).length >= 4,
    'declared, incremented, and used at least twice'
  );
}

group('The principle, stated where the next person will look');
{
  // Not decoration: these comments are the only thing that stops the pattern being
  // reintroduced by someone reading `?? 0` as a tidy-up.
  check('queries.ts explains why total is nullable', /is a fact about this request/.test(prose(queries)));
  check('readyInventory still documents the same rule', /has to say so/.test(prose(demand)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
