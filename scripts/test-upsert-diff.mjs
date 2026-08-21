/**
 * The comparison that decides whether a row is worth rewriting.
 *
 *   node --experimental-transform-types --no-warnings \
 *     --import ./scripts/lib/register-alias.mjs scripts/test-upsert-diff.mjs
 *
 * Every source re-fetches its whole window on every run, so most of a batch is
 * already stored identically. Writing it anyway is what took fifteen sources down
 * with "canceling statement due to statement timeout" — each row writes a new
 * tuple, marks the old dead, and updates all 21 indexes on canonical_projects.
 *
 * So upsertSourceRecords now compares before writing, and this file covers the two
 * ways that can go wrong:
 *
 *   TOO EAGER   reports "same" when the row really changed, and the update is
 *               silently dropped. The row goes stale and nothing logs it. This is
 *               the failure that matters and most of the cases below are about it.
 *
 *   TOO SHY     reports "different" for an identical row, and the optimisation
 *               quietly does nothing while appearing to work. Cheap, but it makes
 *               the fix a lie — which is why the run log prints the skip rate.
 *
 * The dialect cases are the interesting ones. The incoming record is JavaScript;
 * the stored row is whatever PostgREST decoded out of Postgres, so a date written
 * as '2026-08-01' comes back as '2026-08-01T00:00:00+00:00'. Calling those
 * different would mark every dated row changed on every run and buy nothing.
 */

import { sameStoredValue } from '@/lib/sources/upsertRecords';

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

const same = (a, b) => sameStoredValue(a, b) === true;
const differs = (a, b) => sameStoredValue(a, b) === false;

group('Identical values are the same, so the write is skipped');
{
  check('equal strings', same('Dublin data centre', 'Dublin data centre'));
  check('equal numbers', same(1450, 1450));
  check('equal booleans', same(true, true));
  check('both null', same(null, null));
  check('null against undefined — the same absence', same(undefined, null));
  check('equal arrays', same(['a', 'b'], ['a', 'b']));
  check('equal objects', same({ a: 1, b: 2 }, { a: 1, b: 2 }));
}

group('Real changes are never reported as the same');
{
  check('a changed name', differs('Dublin data centre', 'Cork data centre'));
  check('a changed number', differs(1450, 1800));
  check('a value appearing where there was none', differs('now set', null));
  check('a value being cleared', differs(null, 'was set'), 'clearing a field is a change');
  check('false is not null', differs(false, null), 'false is a value; null is absence');
  check('zero is not null', differs(0, null), 'zero is a measurement; null is not');
  check('a flipped boolean', differs(true, false));
  check('an extra array element', differs(['a', 'b'], ['a']));
  check('a changed array element', differs(['a', 'b'], ['a', 'c']));
  check('a changed nested value', differs({ a: 1 }, { a: 2 }));
  check('a reordered object is treated as changed', differs({ a: 1, b: 2 }, { b: 2, a: 1 }), 'safe direction');
}

group('The two sides speak different dialects, and that is not a change');
{
  // Postgres hands back a timestamptz; the adapter wrote a plain date.
  check('date written bare, stored with a zone', same('2026-08-01', '2026-08-01T00:00:00+00:00'));
  check('same instant, different offsets', same('2026-08-01T12:00:00Z', '2026-08-01T13:00:00+01:00'));
  check('a numeric string against a number', same('1450', 1450));
  check('a number against a numeric string', same(1450, '1450'));
}

group('Ambiguity resolves toward writing, never toward silence');
{
  /*
    '2000' parses as a Date in JavaScript. A publisher means the year, and a
    year-to-timestamp coincidence must not be allowed to suppress a real update —
    so only values that carry a full date shape are compared as instants.
  */
  check('a bare year is not an instant', differs('2000', '2000-01-01T00:00:00+00:00'));
  check('different real dates still differ', differs('2026-08-01', '2026-08-02T00:00:00+00:00'));
  check('unparseable strings compare literally', differs('n/a', 'unknown'));
  check('a number against a non-numeric string', differs(1450, 'about 1450'));
  check('an object against a string', differs({ a: 1 }, 'a=1'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
