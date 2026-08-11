/**
 * The event log's rules: what gets kept, what gets redacted, what gets bounded.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-events.mjs
 *
 * Only the pure helpers — no database. The writer is deliberately untestable
 * here because its contract is "never throws", and the way to verify that is to
 * read it: every path is inside a try.
 *
 * Two things are worth testing rather than eyeballing. Redaction, because a leak
 * into this table is a second copy of the CRM with weaker access rules and
 * nobody would notice for years. And the bounds, because an unbounded jsonb
 * column with an API response in it becomes the largest table in the database.
 */

import { redactText, sanitiseDetail, shouldRecord, SLOW_MS } from '@/lib/observability/redact';

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

console.log('Contact details never reach the table');
{
  check('an email is replaced', redactText('failed for anas.filali@evercam.io') === 'failed for [email]');
  check(
    'both emails in one line go',
    redactText('a@b.com and c@d.co.uk') === '[email] and [email]',
    redactText('a@b.com and c@d.co.uk')
  );

  /*
    Three shapes, because this roster works several countries and the numbers are
    not uniform. Foreign numbers are kept as DATA elsewhere in this app — they
    are not errors — but in the log they are redacted for the same reason local
    ones are.
  */
  check('an international number goes', redactText('rang +353 1 234 5678') === 'rang [phone]', redactText('rang +353 1 234 5678'));
  check('a dashed number goes', redactText('353-1-234-5678') === '[phone]', redactText('353-1-234-5678'));
  check('a contiguous run goes', redactText('call 35312345678 now') === 'call [phone] now', redactText('call 35312345678 now'));
}

console.log('\nThe log stays readable — redaction is not allowed to eat the numbers');
{
  /*
    This is the case that made the first pattern wrong. A digit followed by six
    or more of [digits, spaces, brackets, dots, dashes] also matches a
    space-separated list of counts, so the tier figures came out as "[phone]".
    Redacting something that was never a phone number in exchange for an
    unreadable log is the wrong trade.
  */
  const line = 'tiers 209 24016 59054 4847';
  check('a space-separated count list survives', redactText(line) === line, redactText(line));
  check('a duration survives', redactText('took 34637 ms') === 'took 34637 ms', redactText('took 34637 ms'));
  check('a short id survives', redactText('page 12 of 88') === 'page 12 of 88');

  // Shape alone is not enough; the digits have to be there too.
  check('1-2-3 is not a phone number', redactText('rule 1-2-3') === 'rule 1-2-3', redactText('rule 1-2-3'));

  // Numeric values are never scanned at all, which is what protects the counts
  // that matter — they arrive as numbers, not text.
  const d = sanitiseDetail({ total: 88126, failedCounts: 3, ratio: 0.47 });
  check('numbers pass through untouched', d.total === 88126 && d.failedCounts === 3 && d.ratio === 0.47, JSON.stringify(d));
  check('booleans pass through', sanitiseDetail({ partial: false }).partial === false);
}

console.log('\nRedaction reaches every depth, not just the top level');
{
  const d = sanitiseDetail({ error: 'x', ctx: { contact: { email: 'a@b.com' } } });
  check('nested strings are redacted', d.ctx.contact.email === '[email]', JSON.stringify(d));
  const arr = sanitiseDetail({ rows: ['a@b.com', 'plain'] });
  check('array members are redacted', arr.rows[0] === '[email]' && arr.rows[1] === 'plain', JSON.stringify(arr));
}

console.log('\nDetail is bounded, so the log cannot become the biggest table');
{
  const long = sanitiseDetail({ error: 'x'.repeat(900) }).error;
  check('a long string is truncated', long.length < 600, String(long.length));
  check('and says how much was dropped', /\[\+400\]$/.test(long), long.slice(-12));

  const wide = sanitiseDetail(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i])));
  check('too many keys are cut', Object.keys(wide).length <= 41, String(Object.keys(wide).length));
  check('and the cut is stated', wide['…'] === 'truncated');

  const many = sanitiseDetail({ xs: Array.from({ length: 60 }, (_, i) => i) }).xs;
  check('a long array is cut', many.length === 41, String(many.length));
  check('and says how many went', /\+20 more/.test(String(many[40])), String(many[40]));

  // Depth, because a cyclic object would otherwise recurse until the stack goes.
  let deep = { v: 'leaf' };
  for (let i = 0; i < 8; i++) deep = { nest: deep };
  check('excessive depth is stopped', JSON.stringify(sanitiseDetail(deep)).includes('[deep]'));

  const cyclic = { name: 'a' };
  cyclic.self = cyclic;
  let survived = true;
  try {
    sanitiseDetail(cyclic);
  } catch {
    survived = false;
  }
  check('a cycle does not blow the stack', survived);
}

console.log('\nUndefined keys are dropped, not stored as null');
{
  /*
    A filter event carries only the filters that were applied. Storing the unset
    ones as null means every event carries the full filter vocabulary and the two
    that were actually used are impossible to see.
  */
  const d = sanitiseDetail({ bu: 'usa', vertical: undefined, tier: null });
  check('unset keys are absent', !('vertical' in d), JSON.stringify(d));
  check('but an explicit null is kept', d.tier === null, JSON.stringify(d));
}

console.log('\nWhat earns a row');
{
  check('a failure always does', shouldRecord({ kind: 'query', name: 'x', ok: false, durationMs: 1 }));
  check('a fast success does not', !shouldRecord({ kind: 'query', name: 'x', ok: true, durationMs: 5 }));
  check('a slow success does', shouldRecord({ kind: 'query', name: 'x', ok: true, durationMs: SLOW_MS }));
  check('just under the line does not', !shouldRecord({ kind: 'query', name: 'x', ok: true, durationMs: SLOW_MS - 1 }));

  /*
    An operator applying a filter has no success or failure, and its value is the
    record that somebody looked — so it is kept regardless of how fast it was.
    Treating `ok: undefined` as a success would silently drop every filter event
    under two seconds, which is all of them.
  */
  check('an outcome-less event is kept', shouldRecord({ kind: 'filter', name: 'records', durationMs: 3 }));
  check('an explicit null outcome is kept', shouldRecord({ kind: 'filter', name: 'records', ok: null, durationMs: 3 }));

  check('the threshold is overridable', !shouldRecord({ kind: 'query', name: 'x', ok: true, durationMs: 2_500 }, 5_000));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
