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
  meetsFloor,
  hqContact,
  hqVerdict,
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

group('Better matching may return fewer people — never nobody');
{
  const project = { stateProvince: 'Texas' };
  const v = (facts) => scoreMatch(facts, project, NRG, Date.parse('2026-08-21T00:00:00Z'));

  /*
    The floor rejects one thing and one thing only. A distant current employee is a
    worse match and still a real person at the right company; withholding them
    would cost a handover to gain nothing.
  */
  check('a departed contact fails the floor', !meetsFloor(v({ state: 'TX', employment: [at('NRG Energy', false, { endDate: '2026-01-01' }), at('Duke Energy', true)] })));
  check('a distant current employee passes', meetsFloor(v({ state: 'Maine', employment: [at('NRG Energy', true)] })));
  check('an unknown-employment contact passes', meetsFloor(v({ state: 'TX' })));

  const org = { name: 'NRG Energy, Inc.', phone: '+1-713-537-3000', location: 'Houston, Texas' };
  const hq = hqContact(org);
  check('the switchboard becomes a usable contact', hq !== null && hq.phone === org.phone);
  check('it carries a phone so the record stays exportable', Boolean(hq?.phone));
  check('and no email, because inventing one would be a lie', hq?.email === null);
  check('its title warns that it is not a person', /main line/i.test(hq?.title ?? ''), hq?.title);
  check('it is labelled as its own source', hq?.source === 'apollo-hq');

  /*
    No phone means there is genuinely nothing to offer. Saying so beats fabricating
    a contact — the point of never-null is to keep the lead callable, and a record
    with no number is not callable however it is dressed up.
  */
  check('no company phone yields null rather than a fake contact', hqContact({ name: 'X', phone: null }) === null);

  const hv = hqVerdict('no current contact found at this company');
  check('an HQ fallback is always low confidence', hv.confidence === 'low');
  check('its geography is unknown, not the head office state', hv.geo === 'unknown');
  check('it says what it is', hv.reasons.some((r) => r.includes('switchboard')));
  check('it scores below any real person', hv.score < v({ state: 'Maine', employment: [at('NRG Energy', true)] }).score);
}

group('What a live reveal actually returned');
{
  /*
    These two cases are not hypotheses. Both come from one credited people/match
    call, which returned city/state/country, a full employment_history with
    organization_id, departments, subdepartments, seniority and functions — and no
    last_refreshed_at, which api_search does return.
  */

  /*
    THE CEO WITH TWO CURRENT JOBS.

    Apollo lists concurrently-held roles as separate `current: true` entries, and a
    parent company is the common case: the reveal showed a CEO current at both
    "Hawaiian Electric" and "HEI". Before this, the parent role was read as a move
    and stamped a job-change warning on the best contact on the record.
  */
  const HECO = { id: 'org_heco', name: 'Hawaiian Electric' };
  const dualCurrent = {
    employment: [
      { organizationId: 'org_heco', organizationName: 'Hawaiian Electric', current: true, startDate: '2022-01-01' },
      { organizationId: 'org_hei', organizationName: 'HEI', current: true },
      { organizationId: 'org_heco', organizationName: 'Hawaiian Electric', current: false, endDate: '2022-01-01' },
    ],
  };
  const dual = employmentAt(dualCurrent, HECO, Date.parse('2026-08-21T00:00:00Z'));
  check('holding a parent-company role too is still current', dual.status === 'current');
  check('and is not reported as having moved', !dual.signals.some((x) => x.startsWith('now at')), dual.signals.join(' | '));
  check('the internal promotion is still surfaced', dual.signals.some((x) => x.includes('within')));

  /*
    THE SUBSIDIARY EMPLOYEE.

    Apollo tracks subsidiaries as separate organisations with their own ids — the
    same response listed "Maui Electric" as a suborganization of Hawaiian Electric.
    So somebody current at the subsidiary has no history at the parent and reads as
    departed. Renames and acquisitions produce the identical shape.

    Reported as `left`, because that is what the record we hold says. Marked
    unconfirmed, and kept, because dropping it loses a real contact to save us from
    a guess.
  */
  const subsidiary = { employment: [{ organizationId: 'org_meco', organizationName: 'Maui Electric', current: true }] };
  const sub = employmentAt(subsidiary, HECO);
  check('a subsidiary employee reads as left', sub.status === 'left');
  check('but that reading is marked unconfirmed', sub.confirmed === false);
  check('and it says the record is silent rather than accusing them', sub.signals.some((x) => x.includes('no record')));

  const project = { stateProvince: 'Hawaii' };
  const v = (facts) => scoreMatch(facts, project, HECO, Date.parse('2026-08-21T00:00:00Z'));
  check('an unconfirmed departure survives the floor', meetsFloor(v(subsidiary)));

  /*
    The rule this whole module exists for, unchanged by the exception above: an
    entry AT the target with an end date is evidence, and it is still dropped.
  */
  const reallyLeft = {
    employment: [
      { organizationId: 'org_heco', organizationName: 'Hawaiian Electric', current: false, endDate: '2026-03-01' },
      { organizationId: 'org_duke', organizationName: 'Duke Energy', current: true },
    ],
  };
  check('a confirmed departure is still confirmed', employmentAt(reallyLeft, HECO).confirmed === true);
  check('and is still dropped', !meetsFloor(v(reallyLeft)));
  check('a confirmed departure outranks nothing', compareVerdicts(v(subsidiary), v(reallyLeft)) < 0);
  /*
    The comparator orders on the rank, so it would pass whatever the points said —
    and the score is persisted as contact_match_score and shown to a seller, so it
    has to be right on its own. Asserted directly rather than through the sort.
  */
  check(
    'and the stored score says so too',
    v(subsidiary).score > v(reallyLeft).score,
    `${v(subsidiary).score} vs ${v(reallyLeft).score}`
  );
  /*
    The tier is worth 15, and the score is asserted outright rather than compared.

    Two softer forms of this were written first and both passed with the tier set
    to 25 — worth the same as knowing nothing, which is the distinction being
    claimed. Each time the `now at Maui Electric` and `no record of them` signals
    deducted enough to make a relative comparison come out right for the wrong
    reason. The arithmetic here is 15 for an unconfirmed departure, 10 for unknown
    geography, less 5 per signal, and pinning it is the only form that fails when
    the tier moves.
  */
  check('an unconfirmed departure is scored as its own tier', v(subsidiary).score === 15, String(v(subsidiary).score));
  check('which is below knowing nothing at all', v(subsidiary).score < v({}).score);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
