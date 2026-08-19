/**
 * The routing-preview cache key.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-routing-snapshot.mjs
 *
 * /control/routing serves a snapshot keyed on a hash of (rules, scoringConfig), because
 * computing the preview live costs 41.5 s against 111,353 records — ~31 s of it just
 * transferring the rows.
 *
 * Keying on the inputs is what makes the cache safe: this screen is where the rules are
 * edited, and a preview of the PREVIOUS ruleset shown to somebody about to re-route the
 * whole book would be worse than a slow page. So an edited rule must be a MISS, and an
 * unchanged one must be a HIT.
 *
 * Both halves fail silently if the hash is wrong, in opposite and equally invisible
 * ways. Hash too loosely and an edited rule serves a stale preview that looks
 * authoritative. Hash too tightly — which is what happens if object key order leaks in,
 * since JSON.stringify preserves insertion order — and every load misses, the page stays
 * at 41 s, and nothing anywhere reports that the cache is not working. Neither shows up
 * as an error, which is why this is asserted directly.
 *
 * Offline: pure hashing, no database.
 */

import { routingPreviewFingerprint } from '@/lib/queries';

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

const RULES = [
  { id: 'r1', name: 'Big USA', enabled: true, match: { bu: 'usa', minValue: 1_000_000 }, route: 'sales', stage: 'act_now' },
  { id: 'r2', name: 'Solar', enabled: true, match: { vertical: 'solar' }, route: 'marketing', stage: 'nurture' },
];
const SCORING = { weights: { timing: 40, value: 30, fit: 30 }, bands: { P1: 80, P2: 60, P3: 40 } };

group('The same inputs always produce the same key');
{
  check('twice over the same objects', routingPreviewFingerprint(RULES, SCORING) === routingPreviewFingerprint(RULES, SCORING));
  check(
    'and over a structurally equal deep copy',
    routingPreviewFingerprint(structuredClone(RULES), structuredClone(SCORING)) === routingPreviewFingerprint(RULES, SCORING)
  );
}

group('Key order must not leak into the key');
{
  /*
    THE FAILURE THIS EXISTS FOR. JSON.stringify preserves insertion order, so without
    canonicalisation the same ruleset arriving with its keys in a different order — a
    different code path building it, a round trip through a form, a reordered column
    list from PostgREST — hashes differently and misses on every single load. The page
    would simply stay slow, with the snapshot table quietly filling with near-duplicates.
  */
  const reordered = [
    { stage: 'act_now', route: 'sales', match: { minValue: 1_000_000, bu: 'usa' }, enabled: true, name: 'Big USA', id: 'r1' },
    { stage: 'nurture', route: 'marketing', match: { vertical: 'solar' }, enabled: true, name: 'Solar', id: 'r2' },
  ];
  check('top-level keys reversed', routingPreviewFingerprint(reordered, SCORING) === routingPreviewFingerprint(RULES, SCORING));

  const scoringReordered = { bands: { P3: 40, P1: 80, P2: 60 }, weights: { fit: 30, value: 30, timing: 40 } };
  check('nested keys reversed', routingPreviewFingerprint(RULES, scoringReordered) === routingPreviewFingerprint(RULES, SCORING));

  check(
    'an explicit undefined is treated as absent',
    routingPreviewFingerprint([{ ...RULES[0], note: undefined }, RULES[1]], SCORING) ===
      routingPreviewFingerprint(RULES, SCORING)
  );
}

group('A genuinely different preview must produce a different key');
{
  const changedValue = [{ ...RULES[0], match: { bu: 'usa', minValue: 2_000_000 } }, RULES[1]];
  check('a changed rule threshold', routingPreviewFingerprint(changedValue, SCORING) !== routingPreviewFingerprint(RULES, SCORING));

  const disabled = [{ ...RULES[0], enabled: false }, RULES[1]];
  check('a disabled rule', routingPreviewFingerprint(disabled, SCORING) !== routingPreviewFingerprint(RULES, SCORING));

  const added = [...RULES, { id: 'r3', name: 'UK', enabled: true, match: { bu: 'uk' }, route: 'sales', stage: 'nurture' }];
  check('an added rule', routingPreviewFingerprint(added, SCORING) !== routingPreviewFingerprint(RULES, SCORING));

  const removed = [RULES[0]];
  check('a removed rule', routingPreviewFingerprint(removed, SCORING) !== routingPreviewFingerprint(RULES, SCORING));

  /*
    ARRAY ORDER IS SIGNIFICANT, unlike object key order. Routing rules are evaluated in
    sequence and the first match wins, so swapping two rules genuinely changes which
    lane records land in — a canonicaliser that sorted arrays "for stability" would
    serve one ruleset's preview for another's, which is the dangerous direction.
  */
  const resequenced = [RULES[1], RULES[0]];
  check('rules in a different ORDER (first match wins)', routingPreviewFingerprint(resequenced, SCORING) !== routingPreviewFingerprint(RULES, SCORING));

  const changedScoring = { ...SCORING, weights: { timing: 50, value: 25, fit: 25 } };
  check('a changed scoring weight', routingPreviewFingerprint(RULES, changedScoring) !== routingPreviewFingerprint(RULES, SCORING));

  check('a changed band cutoff', routingPreviewFingerprint(RULES, { ...SCORING, bands: { ...SCORING.bands, P1: 85 } }) !== routingPreviewFingerprint(RULES, SCORING));
}

group('Degenerate inputs do not throw');
{
  check('no rules at all', typeof routingPreviewFingerprint([], SCORING) === 'string');
  check('and it differs from having rules', routingPreviewFingerprint([], SCORING) !== routingPreviewFingerprint(RULES, SCORING));
  check('a null inside a rule', typeof routingPreviewFingerprint([{ ...RULES[0], match: null }], SCORING) === 'string');
  check('omitted scoring falls back to the default', typeof routingPreviewFingerprint(RULES) === 'string');
  check('the key is a sha256 hex digest', /^[0-9a-f]{64}$/.test(routingPreviewFingerprint(RULES, SCORING)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
