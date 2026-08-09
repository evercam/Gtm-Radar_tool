/**
 * An email is a person. A name is not.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-apollo-identity.mjs
 *
 * This workspace has two people called "Ronniel Manalo", separated only by
 * evercam.io versus evercam.com, and a "Ron Leon" and a "Ronald Leon" who are
 * also different people. Confirmed twice by the user, after I twice assumed they
 * were duplicates.
 *
 * That makes the owner lookup sharper than it looks. It used to fall through to
 * a name match whenever the email matched nobody — so one stale or mistyped
 * address would have quietly handed a person's leads to their namesake, in the
 * CRM, where the first sign of it is somebody working somebody else's list.
 *
 * The fixtures below are this roster and this Apollo workspace, read live on
 * 2026-08-09. Pure — the matcher takes the user list as an argument precisely so
 * this file needs no network.
 */

import { matchApolloUser } from '@/lib/export/apolloUsers';

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

/** The real shape: same names, different addresses, different people. */
const APOLLO = [
  { id: 'u_ronniel_io', name: 'Ronniel Manalo', email: 'ronniel.manalo@evercam.io' },
  { id: 'u_ronniel_com', name: 'Ronniel Manalo', email: 'ronniel.manalo@evercam.com' },
  { id: 'u_ron_com', name: 'Ron Leon', email: 'ron.leon@evercam.com' },
  { id: 'u_ronald_io', name: 'Ronald Leon', email: 'ron.leon@evercam.io' },
  { id: 'u_bekim', name: 'Bekim Zogaj', email: 'bekim.zogaj@evercam.io' },
  { id: 'u_noemail', first_name: 'Dana', last_name: 'Vance' },
];

console.log('The address decides, even when the name does not');
{
  check('the .io Ronniel', matchApolloUser(APOLLO, 'ronniel.manalo@evercam.io', 'Ronniel Manalo') === 'u_ronniel_io');
  check('the .com Ronniel', matchApolloUser(APOLLO, 'ronniel.manalo@evercam.com', 'Ronniel Manalo') === 'u_ronniel_com');
  check('Ron Leon', matchApolloUser(APOLLO, 'ron.leon@evercam.com', 'Ron Leon') === 'u_ron_com');
  check('Ronald Leon', matchApolloUser(APOLLO, 'ron.leon@evercam.io', 'Ronald Leon') === 'u_ronald_io');
  check('case does not matter', matchApolloUser(APOLLO, 'BEKIM.ZOGAJ@EVERCAM.IO', null) === 'u_bekim');
  check('surrounding space does not matter', matchApolloUser(APOLLO, '  bekim.zogaj@evercam.io ', null) === 'u_bekim');
}

console.log('\nA name never overrides an address that was given');
{
  /*
    The fix. An address that matches nobody is a mismatch to fix, and guessing
    from the name is how one person's leads reach their namesake — which, with
    two Ronniel Manalos, is a coin toss.
  */
  check(
    'a mistyped address does not fall back to the namesake',
    matchApolloUser(APOLLO, 'ronniel.manalo@typo.com', 'Ronniel Manalo') === null
  );
  check(
    'nor does a stale one, even when the name is unique',
    matchApolloUser(APOLLO, 'bekim.zogaj@old-domain.com', 'Bekim Zogaj') === null
  );
  check('an address nobody has resolves to nobody', matchApolloUser(APOLLO, 'stranger@example.com', null) === null);
}

console.log('\nThe name path survives, for entries that never had an address');
{
  check('a unique name with no email still matches', matchApolloUser(APOLLO, null, 'Dana Vance') === 'u_noemail');
  check('assembled from first and last name', matchApolloUser(APOLLO, '', 'dana vance') === 'u_noemail');
  /*
    Two people with one name is not a tie to break — whichever sorted first would
    own the contact, and that is not an answer.
  */
  check('an ambiguous name is refused', matchApolloUser(APOLLO, null, 'Ronniel Manalo') === null);
  check('an unknown name is refused', matchApolloUser(APOLLO, null, 'Nobody Here') === null);
}

console.log('\nNothing to match against is not a match');
{
  check('no users', matchApolloUser([], 'bekim.zogaj@evercam.io', 'Bekim Zogaj') === null);
  check('no email and no name', matchApolloUser(APOLLO, null, null) === null);
  check('blank strings', matchApolloUser(APOLLO, '  ', '  ') === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
