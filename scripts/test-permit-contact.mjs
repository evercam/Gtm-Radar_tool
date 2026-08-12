/**
 * The person named on a permit — extraction rules.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-permit-contact.mjs
 *
 * Pure, so no database.
 *
 * The rejections matter more than the acceptances here. A permit feed puts the
 * literal string "owner" in the owner-name field when the applicant is acting for
 * themselves, and business names turn up in name fields when a company filed. Both
 * are present, both are truthy, and storing either produces a lead addressed to
 * "Owner" or "521 Broadway" — which is worse than an empty field, because the
 * export cannot tell the difference and will happily send it.
 *
 * Every fixture below is shaped from real NYC/Chicago payloads observed in
 * canonical_projects.raw_data.
 */

import { permitContactFrom } from '@/lib/import/permitContact';

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

console.log('A named applicant is extracted');
{
  const owner = permitContactFrom({ owner_s_first_name: 'Daniel', owner_s_last_name: 'Wiener', owner_s_business_name: 'Forty One Associates LC' });
  check('owner first + last becomes a name', owner?.name === 'Daniel Wiener', JSON.stringify(owner));
  check('the role is recorded', owner?.role === 'owner');
  check('the business travels with it', owner?.company === 'Forty One Associates LC');
  check('and the source fields are named for provenance', owner?.fields.join(',') === 'owner_s_first_name,owner_s_last_name', owner?.fields.join(','));

  /*
    The permittee pulled the permit and is doing the work, so they outrank the
    owner where both exist — the owner is often a holding company's officer with
    no involvement in the build.
  */
  const both = permitContactFrom({
    owner_s_first_name: 'Ann', owner_s_last_name: 'Holder',
    permittee_s_first_name: 'Bob', permittee_s_last_name: 'Builder',
  });
  check('the permittee wins over the owner', both?.name === 'Bob Builder' && both?.role === 'permittee', JSON.stringify(both));
}

console.log('\nSHOUTED names are calmed down');
{
  // Both cases appear in the same table, so a rep's email would otherwise shout.
  const loud = permitContactFrom({ owner_s_first_name: 'MOZAFAR', owner_s_last_name: 'ZAHABIAN' });
  check('all-caps is title-cased', loud?.name === 'Mozafar Zahabian', loud?.name);
  const mixed = permitContactFrom({ owner_s_first_name: 'Dong', owner_s_last_name: 'Jung' });
  check('an already-cased name is untouched', mixed?.name === 'Dong Jung', mixed?.name);
  const hyphen = permitContactFrom({ owner_s_first_name: 'MARY-JANE', owner_s_last_name: "O'BRIEN" });
  check('hyphens and apostrophes keep their capitals', hyphen?.name === "Mary-Jane O'Brien", hyphen?.name);
}

console.log('\nWhat is present but is not a person');
{
  // Observed literally: the owner field reads "owner" when they filed for themselves.
  check('the word "owner" is rejected', permitContactFrom({ owner_name: 'owner' }) === null);
  check('"N/A" is rejected', permitContactFrom({ owner_name: 'N/A' }) === null);
  check('"SELF" is rejected', permitContactFrom({ owner_name: 'SELF' }) === null);

  // A company filed. Storing this addresses the email to a legal entity.
  check('an LLC is rejected', permitContactFrom({ owner_name: 'AL MARWA CENTER INC.' }) === null, JSON.stringify(permitContactFrom({ owner_name: 'AL MARWA CENTER INC.' })));
  check('an address in the name field is rejected', permitContactFrom({ owner_name: '521 BROADWAY' }) === null, JSON.stringify(permitContactFrom({ owner_name: '521 BROADWAY' })));
  check('a Properties entity is rejected', permitContactFrom({ owner_name: 'Hudson Yards Properties' }) === null);

  // A surname alone cannot be addressed, and cannot be matched in Apollo.
  check('a lone surname is rejected', permitContactFrom({ owner_s_last_name: 'Wiener' }) === null);
  check('a first name alone is rejected', permitContactFrom({ owner_s_first_name: 'Daniel' }) === null);

  // A reference number in the wrong column.
  check('a mostly-numeric value is rejected', permitContactFrom({ owner_name: '12345 67890' }) === null);
}

console.log('\nAn unrecognised feed yields nothing rather than a guess');
{
  check('an empty payload gives null', permitContactFrom({}) === null);
  check('null gives null', permitContactFrom(null) === null);
  check('a feed with no name fields gives null', permitContactFrom({ job_number: '123', borough: 'MANHATTAN' }) === null);
  check('a non-object gives null', permitContactFrom('nope') === null);

  // Blank strings are present-but-empty in these feeds, constantly.
  check('blank first/last gives null', permitContactFrom({ owner_s_first_name: '  ', owner_s_last_name: '' }) === null);
  check('a name with no company still works', permitContactFrom({ owner_s_first_name: 'Sam', owner_s_last_name: 'Reed' })?.company === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
