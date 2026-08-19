/**
 * The routing preview's two-stage cache.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-routing-snapshot.mjs
 *
 * /control/routing is two stages with different inputs, cached at the seam:
 *
 *   score 111,353 rows into ~5,958 groups   keyed on the SCORING config   ~42 s
 *   route those groups with the rules       recomputed every call         ~26 ms
 *
 * The contract is therefore the opposite of what it looks like at first glance, and
 * getting it backwards fails silently in one direction or the other:
 *
 *   rules must NOT enter the cache key. If they do, every rule edit discards a
 *   42-second scan the rules could not have affected — which is the bug this design
 *   replaced. Nothing errors; the page just stays slow on the one screen where rules
 *   are edited.
 *
 *   scoring MUST enter the cache key. If it does not, a scoring-policy change serves
 *   groups scored under the old policy, and the preview describes a re-route that
 *   will not happen. Nothing errors; the numbers are simply wrong.
 *
 *   and the ROUTED OUTPUT must still change when the rules change, because that half
 *   is recomputed rather than cached. If it did not, the cache would be serving a
 *   stale preview through a correct-looking key.
 *
 * Object key order must not leak into the key either: JSON.stringify preserves
 * insertion order, so without canonicalisation the same policy arriving with its keys
 * ordered differently misses on every load.
 *
 * Offline: pure hashing and in-memory routing, no database.
 */

import { routingScoringFingerprint, previewFromScoreGroups } from '@/lib/queries';

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

const SCORING = { weights: { timing: 40, value: 30, fit: 30 }, bands: { P1: 80, P2: 60, P3: 40 } };

group('The scoring config determines the key');
{
  check('same config, same key', routingScoringFingerprint(SCORING) === routingScoringFingerprint(SCORING));
  check(
    'a deep copy hashes the same',
    routingScoringFingerprint(structuredClone(SCORING)) === routingScoringFingerprint(SCORING)
  );
  check(
    'key order does not leak in',
    routingScoringFingerprint({ bands: { P3: 40, P1: 80, P2: 60 }, weights: { fit: 30, value: 30, timing: 40 } }) ===
      routingScoringFingerprint(SCORING)
  );
  check(
    'a changed weight changes the key',
    routingScoringFingerprint({ ...SCORING, weights: { timing: 50, value: 25, fit: 25 } }) !==
      routingScoringFingerprint(SCORING)
  );
  check(
    'a changed band cutoff changes the key',
    routingScoringFingerprint({ ...SCORING, bands: { ...SCORING.bands, P1: 85 } }) !== routingScoringFingerprint(SCORING)
  );
  check('the key is a sha256 hex digest', /^[0-9a-f]{64}$/.test(routingScoringFingerprint(SCORING)));
  check('omitted config falls back to the default', typeof routingScoringFingerprint() === 'string');
}

/*
  The routing half. Two groups that differ only in the field the rule matches on, so
  a rule change has to move records between lanes.
*/
const GROUPS = [
  {
    record: { bu: 'usa', icp_code: 'developer', vertical: 'solar', record_type: 'project', contact_status: 'has_contact', population_percentage: 90, country: 'US', key_account: false, key_account_score: null, priority_score: 90, priority_band: 'P1' },
    score: 90,
    band: 'P1',
    n: 100,
  },
  {
    record: { bu: 'uk', icp_code: 'tier1_gc', vertical: 'construction', record_type: 'project', contact_status: 'needs_enrichment', population_percentage: 20, country: 'GB', key_account: false, key_account_score: null, priority_score: 20, priority_band: 'P4' },
    score: 20,
    band: 'P4',
    n: 300,
  },
];
const TOTAL = 400;

group('Routing is recomputed, never cached');
{
  const usaOnly = [{ name: 'USA to sales', enabled: true, match: { bu: ['usa'] }, assign: { route: 'sales', stage: 'act_now' } }];
  const ukOnly = [{ name: 'UK to sales', enabled: true, match: { bu: ['uk'] }, assign: { route: 'sales', stage: 'act_now' } }];

  const a = previewFromScoreGroups(GROUPS, TOTAL, usaOnly);
  const b = previewFromScoreGroups(GROUPS, TOTAL, ukOnly);

  const sales = (p) => p.byLane.filter((l) => l.route === 'sales').reduce((s, l) => s + l.count, 0);
  check('the same groups route differently under different rules', sales(a) !== sales(b), `${sales(a)} vs ${sales(b)}`);
  check('the USA rule claims the 100-record group', sales(a) === 100, `got ${sales(a)}`);
  check('the UK rule claims the 300-record group', sales(b) === 300, `got ${sales(b)}`);
}

group('A group stands for n records, not one');
{
  const none = previewFromScoreGroups(GROUPS, TOTAL, []);
  check('lane counts sum to the record total', none.byLane.reduce((s, l) => s + l.count, 0) === TOTAL);
  check('rule counts sum to the record total', none.byRule.reduce((s, r) => s + r.count, 0) === TOTAL);
  check('band counts sum to the record total', none.byBand.reduce((s, b) => s + b.count, 0) === TOTAL);
  check('bands are weighted by n', none.byBand.find((b) => b.band === 'P4')?.count === 300);

  /*
    The mean must be weighted. Averaging the GROUPS rather than the records it stands
    for would give (90+20)/2 = 55 here instead of (90*100 + 20*300)/400 = 37.5 -> 38,
    and the error would scale with how unevenly records are distributed across groups.
  */
  check('avgPriority weights score by n', none.avgPriority === 38, `got ${none.avgPriority}`);
}

group('Facets come from the groups');
{
  const p = previewFromScoreGroups(GROUPS, TOTAL, []);
  check('bu facet is sorted and complete', JSON.stringify(p.facets.bu) === JSON.stringify(['uk', 'usa']));
  check('vertical facet is sorted and complete', JSON.stringify(p.facets.vertical) === JSON.stringify(['construction', 'solar']));
  check('country facet is sorted and complete', JSON.stringify(p.facets.country) === JSON.stringify(['GB', 'US']));
}

group('Degenerate inputs do not throw');
{
  const empty = previewFromScoreGroups([], 0, []);
  check('no groups', empty.total === 0 && empty.byLane.length === 0);
  check('avgPriority is 0 rather than NaN', empty.avgPriority === 0);
  check('bands are still all four, at zero', empty.byBand.length === 4 && empty.byBand.every((b) => b.count === 0));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
