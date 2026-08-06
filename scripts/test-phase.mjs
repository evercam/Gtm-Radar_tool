/**
 * 117 source phases collapse to 11, and nothing is guessed.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-phase.mjs
 *
 * `current_phase` carries 117 distinct values because ten feeds each name things
 * their own way. Too many to filter, far too many for a picklist, and several are
 * not even distinct — "Decision Issued" appears 211 times and again 125 times with
 * trailing spaces.
 *
 * The assertions that matter are about NOT lying. An unrecognised value must come
 * back null rather than land in the nearest bucket, and the states that mean
 * genuinely different things to a rep — permitting versus approved versus
 * cancelled — must not collapse into each other.
 *
 * Pure: every input below was observed in the live data.
 */

import { matchPhase, normalisePhase, PROJECT_PHASES } from '@/lib/phase';

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
const is = (raw, want) =>
  check(`${JSON.stringify(raw)} -> ${want}`, normalisePhase(raw) === want, `got ${normalisePhase(raw)}`);

console.log('The canonical set is small enough to be a picklist');
{
  check('11 phases', PROJECT_PHASES.length === 11, String(PROJECT_PHASES.length));
  check('all distinct', new Set(PROJECT_PHASES).size === PROJECT_PHASES.length);
}

console.log('\nEach source vocabulary lands where it should');
{
  is('IN PROCESS', 'Permitting'); // nyc_dob_permits, 19,939 records
  is('Operating', 'Operating'); // gem, 12,574
  is('Awarded', 'Awarded'); // usaspending / tender feeds, 5,944
  is('NEW APPLICATION', 'Permitting'); // planning_ie, 2,726
  is('Pre-Construction', 'Pre-construction');
  is('Under Construction', 'Under construction');
  is('Tender', 'Tendering');
  is('Plans Approved', 'Approved'); // glenigan
  is('Pipeline', 'Planned'); // world_bank
  is('Announcement', 'Planned'); // news feeds
  is('Mothballed', 'On hold');
  is('Retired', 'Retired');
}

console.log('\nWhitespace duplicates collapse');
{
  // "Decision Issued" 211 + "Decision Issued        " 125 are one value.
  check(
    'trailing spaces do not make a new phase',
    normalisePhase('Decision Issued') === normalisePhase('Decision Issued                        '),
    `${normalisePhase('Decision Issued')} vs ${normalisePhase('Decision Issued      ')}`
  );
  check('inner runs collapse', normalisePhase('35  Day   Assessment') === normalisePhase('35 Day Assessment'));
  check('case does not matter', normalisePhase('operating') === normalisePhase('OPERATING'));
}

console.log('\nStates that mean different things stay different');
{
  // The whole point of the exercise: these must not merge.
  check('permitting is not approved', normalisePhase('35 Day Assessment') !== normalisePhase('Final Grant'));
  check('approved is not under construction', normalisePhase('Final Grant') !== normalisePhase('Construction'));
  check('on hold is not cancelled', normalisePhase('Mothballed') !== normalisePhase('Cancelled'));
  check('retired is not operating', normalisePhase('Retired') !== normalisePhase('Operating'));
  check('planned is not permitting', normalisePhase('Proposed') !== normalisePhase('IN PROCESS'));
}

console.log('\nThe judgement calls, pinned so a later edit has to mean it');
{
  // An application being corrected is alive; one closed out is not.
  is('Invalid Details Sent to Applicant', 'Permitting');
  is('Invalid - Case Closed', 'Cancelled');
  // gem suffixes inferred states; the prefix carries the meaning.
  is('Shelved - Inferred 2 Y', 'On hold');
  is('Cancelled - Inferred 4 Y', 'Cancelled');
  // An appeal is still in the planning process, not a dead project.
  is('Decision Appealed', 'Permitting');
  is('Application Withdrawn', 'Cancelled');
  // world_bank: Closed means delivered, Dropped means abandoned.
  is('Closed', 'Operating');
  is('Dropped', 'Cancelled');
}

console.log('\nAn unknown value is never guessed');
{
  check('unrecognised -> null', normalisePhase('Fnord Phase 7') === null, String(normalisePhase('Fnord Phase 7')));
  check('and is reported as unmapped', matchPhase('Fnord Phase 7').via === 'unmapped');
  check('empty -> null', normalisePhase('') === null);
  check('whitespace only -> null', normalisePhase('   ') === null);
  check('null -> null', normalisePhase(null) === null);
  check('undefined -> null', normalisePhase(undefined) === null);
}

console.log('\nHow a match was decided is traceable');
{
  check('an exact hit says exact', matchPhase('Operating').via === 'exact');
  check('a pattern hit says rule', matchPhase('Awaiting Technical Validation').via === 'rule');
  check('and still resolves', matchPhase('Awaiting Technical Validation').phase === 'Permitting');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
