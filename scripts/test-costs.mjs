/**
 * Enrichment cost model — against the REAL src/lib/costs.ts.
 *
 * The whole point of this calculator is to be trusted before money is spent,
 * so the failure that matters is UNDER-stating: an engine that silently costs
 * nothing, a cap that is ignored, a per-contact figure that flatters a run
 * which found nothing. Those are the cases weighted here.
 *
 *   node --experimental-transform-types scripts/test-costs.mjs
 */

import { calculateCost, costPerOutcome, DEFAULT_RATES as R } from '../src/lib/costs.ts';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const group = (n) => console.log(`\n${n}`);

const base = {
  records: 100,
  claudeEnabled: false,
  callPrepEnabled: false,
  apolloEnabled: false,
  contactsPerAccount: 5,
  revealPhones: false,
  maxPhoneReveals: 10,
  phoneHitRate: 0.5,
};
const run = (o) => calculateCost({ ...base, ...o }, R);
const line = (b, needle) => b.lines.find((l) => l.label.includes(needle));

group('Nothing enabled costs nothing');
{
  const b = run({});
  check('total is zero', b.totalUsd === 0, String(b.totalUsd));
  check('no credits consumed', b.totalCredits === 0);
  check('GLEIF is listed anyway, at zero', line(b, 'GLEIF')?.usd === 0);
  check('per-record is zero, not NaN', b.perRecordUsd === 0);
}

group('Zero records never bills');
for (const o of [{ claudeEnabled: true }, { apolloEnabled: true }, { apolloEnabled: true, revealPhones: true }]) {
  const b = calculateCost({ ...base, ...o, records: 0 }, R);
  check(`zero records with ${Object.keys(o).join('+')} costs nothing`, b.totalUsd === 0, String(b.totalUsd));
}
check('a negative volume does not produce a negative bill', calculateCost({ ...base, records: -50, apolloEnabled: true }, R).totalUsd === 0);
check('a fractional volume is floored', calculateCost({ ...base, records: 10.9, apolloEnabled: true }, R).records === 10);

group('Each engine adds cost — none is silently free');
{
  const none = run({});
  const claude = run({ claudeEnabled: true });
  const apollo = run({ apolloEnabled: true });
  check('Claude costs more than nothing', claude.totalUsd > none.totalUsd);
  check('Apollo costs more than nothing', apollo.totalUsd > none.totalUsd);
  check('both together cost more than either', run({ claudeEnabled: true, apolloEnabled: true }).totalUsd > Math.max(claude.totalUsd, apollo.totalUsd));
}

group('Call-prep is a real second pass, and needs Claude');
{
  const one = run({ claudeEnabled: true });
  const two = run({ claudeEnabled: true, callPrepEnabled: true });
  check('adding call-prep raises the bill', two.totalUsd > one.totalUsd);
  check('by the configured multiplier', Math.abs(two.totalUsd - one.totalUsd * (1 + R.callPrepFactor)) < 0.01, `${two.totalUsd} vs ${one.totalUsd}`);
  check('call-prep alone bills nothing without Claude', run({ callPrepEnabled: true }).totalUsd === 0);
}

group('Apollo bills per person, not per record');
{
  const five = run({ apolloEnabled: true, contactsPerAccount: 5 });
  const ten = run({ apolloEnabled: true, contactsPerAccount: 10 });
  check('doubling contacts doubles the credits', ten.totalCredits === five.totalCredits * 2, `${ten.totalCredits} vs ${five.totalCredits}`);
  check('100 records x 5 contacts x 1 credit = 500', five.totalCredits === 500, String(five.totalCredits));
  check('zero contacts per account bills nothing', run({ apolloEnabled: true, contactsPerAccount: 0 }).totalCredits === 0);
}

group('Phone reveal respects its cap and its hit rate');
{
  const capped = run({ apolloEnabled: true, revealPhones: true, maxPhoneReveals: 10, phoneHitRate: 1 });
  const reveal = line(capped, 'direct dial');
  check('the reveal line exists', Boolean(reveal));
  check('capped at 10 reveals x 8 credits = 80', reveal.credits === 80, String(reveal.credits));

  const half = run({ apolloEnabled: true, revealPhones: true, maxPhoneReveals: 10, phoneHitRate: 0.5 });
  check('a 50% hit rate halves the reveal credits', line(half, 'direct dial').credits === 40, String(line(half, 'direct dial').credits));

  const miss = run({ apolloEnabled: true, revealPhones: true, maxPhoneReveals: 10, phoneHitRate: 0 });
  check('nothing found means nothing billed for reveals', line(miss, 'direct dial').credits === 0);

  const smallRun = run({ records: 3, apolloEnabled: true, revealPhones: true, maxPhoneReveals: 100, phoneHitRate: 1 });
  check('the cap cannot exceed the run size', line(smallRun, 'direct dial').credits === 24, String(line(smallRun, 'direct dial').credits));

  check('reveal is ignored when Apollo is off', !line(run({ revealPhones: true }), 'direct dial'));
  check('a hit rate above 1 is clamped', line(run({ apolloEnabled: true, revealPhones: true, maxPhoneReveals: 10, phoneHitRate: 5 }), 'direct dial').credits === 80);
}

group('A mobile is 8x a contact match — the reason reveal is off by default');
check('documented ratio holds', R.apolloPhoneCredits === R.apolloMatchCredits * 8);

group('Totals hold together');
{
  const b = run({ claudeEnabled: true, callPrepEnabled: true, apolloEnabled: true, revealPhones: true });
  check('total equals the sum of the lines', Math.abs(b.totalUsd - b.lines.reduce((s, l) => s + l.usd, 0)) < 0.001);
  check('per-record equals total ÷ records', Math.abs(b.perRecordUsd - b.totalUsd / 100) < 0.001);
  check('credits are counted once', b.totalCredits === b.lines.reduce((s, l) => s + (l.credits ?? 0), 0));
}

group('Cost per outcome refuses to flatter a run that found nothing');
{
  const b = run({ apolloEnabled: true });
  check('zero outcomes yields null, not Infinity', costPerOutcome(b, 0) === null);
  check('negative outcomes yields null', costPerOutcome(b, -3) === null);
  check('ten outcomes divides correctly', Math.abs(costPerOutcome(b, 10) - b.totalUsd / 10) < 0.001);
  check('fewer outcomes means a higher unit cost', costPerOutcome(b, 5) > costPerOutcome(b, 50));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
