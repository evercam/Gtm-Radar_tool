/**
 * Which Apollo contact fits the project, and why.
 *
 *   node --experimental-transform-types --no-warnings \
 *     --import ./scripts/lib/register-alias.mjs scripts/test-contact-match.mjs
 *
 * Contacts used to be chosen on reachability and title seniority alone, so a
 * Project Director who left in March outranked a current site manager in the right
 * state. This covers the three signals that now sit between them.
 *
 * The cases are weighted toward two failures, because they are the ones that put a
 * bad contact in front of a seller:
 *
 *   A FORMER EMPLOYEE WINNING. The whole point. Someone who has left is not a
 *     weaker match, they are the wrong person, and no seniority fixes it.
 *
 *   `unknown` BEING TREATED AS FAR. 41% of reachable leads carry no state at all.
 *     Scoring those as distant would demote two fifths of the book for a
 *     publisher's missing field rather than for anything about the contact — a
 *     silent, plausible-looking regression that no error would ever reveal.
 */

import {
  companyKey,
  sameCompany,
  stateCode,
  distanceKm,
  geoMatch,
  employmentAt,
  scoreMatch,
  compareVerdicts,
} from '@/lib/enrich/contactMatch';

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

const NRG = { id: 'org_1', name: 'NRG Energy, Inc.' };
const at = (name, current, extra = {}) => ({ organizationName: name, current, ...extra });

group('One company, however it is spelled');
{
  check('legal suffixes do not matter', companyKey('NRG Energy, Inc.') === companyKey('NRG Energy'));
  check('case does not matter', companyKey('nrg energy') === companyKey('NRG Energy'));
  check('ampersands normalise', companyKey('Black & Veatch') === companyKey('Black and Veatch'));
  check('different companies stay different', companyKey('NRG Energy') !== companyKey('Duke Energy'));
  check('ids win when both sides have them', sameCompany({ id: 'a', name: 'X' }, { id: 'a', name: 'Y' }));
  check('mismatched ids are not the same company', !sameCompany({ id: 'a', name: 'X' }, { id: 'b', name: 'X' }));
  check('falls back to names when ids are absent', sameCompany({ name: 'NRG Energy Inc' }, { name: 'NRG Energy' }));
}

group('A state is a state however it is written');
{
  check('full name to code', stateCode('Texas') === 'TX');
  check('lowercase full name', stateCode('texas') === 'TX');
  check('a code stays a code', stateCode('tx') === 'TX');
  check('two words', stateCode('New Mexico') === 'NM');
  check('absent stays absent', stateCode(null) === null);
  check('an unknown region is not silently a US code', stateCode('Bavaria') === 'bavaria');
}

group('Where the contact is, relative to the project');
{
  const project = { stateProvince: 'Texas' };
  check('same state', geoMatch({ state: 'TX' }, project).geo === 'same_state');
  check('spelled differently, still the same state', geoMatch({ state: 'texas' }, project).geo === 'same_state');
  check('a neighbour is nearby', geoMatch({ state: 'Oklahoma' }, project).geo === 'nearby');
  check('a non-neighbour is distant', geoMatch({ state: 'Maine' }, project).geo === 'distant');

  /*
    The load-bearing pair. Either side missing means we could not judge, and that
    is a different answer from "far" — see the module docblock.
  */
  check('no contact state is unknown, not distant', geoMatch({}, project).geo === 'unknown');
  check('no project state is unknown, not distant', geoMatch({ state: 'TX' }, {}).geo === 'unknown');
}

group('Distance, only when both sides carry coordinates');
{
  const houston = { latitude: 29.76, longitude: -95.37 };
  const dallas = { latitude: 32.78, longitude: -96.8 };
  const d = distanceKm(houston, dallas);
  check('a real distance is computed', d !== null && d > 300 && d < 400, String(d));
  check('one side missing yields null', distanceKm(houston, {}) === null);
  check('null is not zero', distanceKm({}, {}) !== 0);
}

group('Still there, or gone?');
{
  const current = { employment: [at('NRG Energy', true)] };
  check('current at the target company', employmentAt(current, NRG).status === 'current');

  const left = { employment: [at('NRG Energy', false, { endDate: '2026-03-01' }), at('Duke Energy', true)] };
  check('current elsewhere means they left', employmentAt(left, NRG).status === 'left');
  check('and says where they went', employmentAt(left, NRG).signals.some((s) => s.includes('Duke')));

  check('no history at all is unknown, not gone', employmentAt({ employment: [] }, NRG).status === 'unknown');
  /*
    Currently at Shell with no NRG history at all. Not "unknown": whatever the
    search matched on, this person is demonstrably somewhere else now, and the
    operational conclusion is the same as having left. Naming it honestly matters —
    the first version of this case was labelled "unknown" while asserting "left".
  */
  check(
    'current elsewhere with no target history is treated as left',
    employmentAt({ employment: [at('Shell', true)] }, NRG).status === 'left'
  );
}

group('Job-change signals are reasons, not one boolean');
{
  const now = Date.parse('2026-08-21T00:00:00Z');
  const justMoved = { employment: [at('NRG Energy', false, { endDate: '2026-07-01' }), at('Duke Energy', true, { startDate: '2026-07-15' })] };
  const r = employmentAt(justMoved, NRG, now);
  check('a recent start elsewhere is flagged', r.signals.some((s) => s.includes('recently')));
  check('an end date at the target is flagged', r.signals.some((s) => s.includes('end date')));

  const longAgo = { employment: [at('Duke Energy', true, { startDate: '2019-01-01' })] };
  check('an old move is not called recent', !employmentAt(longAgo, NRG, now).signals.some((s) => s.includes('recently')));

  const promoted = { employment: [at('NRG Energy', true, { title: 'Director' }), at('NRG Energy', false, { title: 'Manager' })] };
  check('a move within the company is flagged', employmentAt(promoted, NRG).signals.some((s) => s.includes('within')));
  check('and they are still current there', employmentAt(promoted, NRG).status === 'current');
}

group('The verdict orders candidates the way the spec asks');
{
  const project = { stateProvince: 'Texas' };
  const v = (facts) => scoreMatch(facts, project, NRG, Date.parse('2026-08-21T00:00:00Z'));

  const currentSameState = v({ state: 'TX', employment: [at('NRG Energy', true)] });
  const currentFar = v({ state: 'Maine', employment: [at('NRG Energy', true)] });
  const formerSameState = v({ state: 'TX', employment: [at('NRG Energy', false, { endDate: '2026-01-01' }), at('Duke Energy', true)] });
  const unknownBoth = v({});

  // The headline rule.
  check(
    'a current employee beats a former one in the same state',
    compareVerdicts(currentFar, formerSameState) < 0,
    'a stale same-state contact must not outrank a current distant one'
  );
  check('same state beats a distant state, both current', compareVerdicts(currentSameState, currentFar) < 0);
  check('the best case scores highest', currentSameState.score > currentFar.score && currentSameState.score > formerSameState.score);

  const currentUnknownGeo = v({ employment: [at('NRG Energy', true)] });
  check('unknown geography beats distant geography', compareVerdicts(currentUnknownGeo, currentFar) < 0);

  check('a full match is high confidence', currentSameState.confidence === 'high');
  check('a departed contact is low confidence whatever else is true', formerSameState.confidence === 'low');
  check('knowing nothing is low confidence', unknownBoth.confidence === 'low');
  check('every verdict explains itself', currentSameState.reasons.length >= 2 && formerSameState.reasons.length >= 2);
  check('the reason names the problem', formerSameState.reasons.some((x) => x.includes('no longer')));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
