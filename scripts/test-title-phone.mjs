/**
 * A long title is shortened, never dropped — and the phone rides the call that works.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-title-phone.mjs
 *
 * Two findings from the live API, neither visible from a payload alone:
 *
 *   Apollo's NATIVE `title` caps at 100 characters and stores NULL past it rather
 *   than clipping, so a 206-character title arrived as no title at all — worse
 *   than a shortened one, and silent. Established by bisection: 100 stores, 101
 *   does not.
 *
 *   `direct_phone` is ignored by bulk_create and works on the follow-up PUT, like
 *   owner_id and label_names before it. It is also write-only: reading it back
 *   always returns null because Apollo files the value into `phone_numbers[]`,
 *   which is why this looked for a long time like the phone was never stored.
 *
 * What is asserted is the SPLIT — which field belongs in which request. Pure: no
 * network, no key, no database.
 */

import { toApolloPayload, buildDetailPatch, NATIVE_TITLE_MAX } from '@/lib/export/apollo';

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

const LONG =
  'Experienced in Design/Construction/Quality Control Management of Projects for Private/public Sectors Including Data Centers, Hospitals, Research Labs, Goverment Office Tenant Improvement and Lease Excution.';

const contact = {
  leadId: 'lead-1',
  firstName: 'Zzz',
  lastName: 'Probe',
  name: 'Zzz Probe',
  email: 'zzz@example.net',
  phone: '+1 555 0777',
  title: LONG,
  organizationName: 'ZZZ',
  website: 'https://example.net',
  linkedinUrl: 'https://linkedin.com/in/x',
  ownerId: 'owner-123',
  label: 'LDR — Someone',
  customFields: { 'field-id': LONG },
};

const created = toApolloPayload(contact);
const patch = buildDetailPatch(contact, 'label-abc');

console.log('The native title is clipped to fit, never dropped');
{
  check('the cap is the measured one', NATIVE_TITLE_MAX === 100, String(NATIVE_TITLE_MAX));
  check(`a ${LONG.length}-char title is shortened`, created.title.length <= NATIVE_TITLE_MAX, `${created.title.length}`);
  check('it is not null — a dropped title is worse than a short one', Boolean(created.title));
  check('the shortening is marked', /…$/.test(created.title), created.title);
  const short = toApolloPayload({ ...contact, title: 'Construction Director' });
  check('a title that fits is left exactly alone', short.title === 'Construction Director', short.title);
  check('a null title stays null rather than becoming ""', toApolloPayload({ ...contact, title: null }).title === null);
  const exact = 'A'.repeat(NATIVE_TITLE_MAX);
  check('exactly at the cap is untouched', toApolloPayload({ ...contact, title: exact }).title === exact);
  check('one over the cap is clipped', toApolloPayload({ ...contact, title: 'A'.repeat(NATIVE_TITLE_MAX + 1) }).title.length === NATIVE_TITLE_MAX);
}

console.log('\nThe full title still travels — nothing is eliminated');
{
  // The custom field carries it whole; its own ceiling is policed by
  // mapCustomFields against Apollo's live text_field_max_length, which is why
  // raising that ceiling in Apollo stops the truncation with no code change.
  check('the custom field keeps every character', created.typed_custom_fields['field-id'] === LONG);
  check(`all ${LONG.length} of them`, created.typed_custom_fields['field-id'].length === LONG.length);
}

console.log('\nNothing bulk_create ignores is sent to bulk_create');
{
  check('no direct_phone', created.direct_phone === undefined, JSON.stringify(created.direct_phone));
  check('no owner_id', created.owner_id === undefined);
  check('no label_names', created.label_names === undefined);
  check('no label_ids either — create ignores those too', created.label_ids === undefined);
  // The things create DOES honour must still be there.
  check('but the email is', created.email === 'zzz@example.net');
  check('and the organisation', created.organization_name === 'ZZZ');
  check('and the linkedin url', created.linkedin_url === 'https://linkedin.com/in/x');
  check('and the custom fields', Object.keys(created.typed_custom_fields).length === 1);
}

console.log('\nThe follow-up write carries exactly what create dropped');
{
  check('the phone', patch.direct_phone === '+1 555 0777');
  check('the owner', patch.owner_id === 'owner-123');
  check('the list, by id', JSON.stringify(patch.label_ids) === '["label-abc"]');
  // Assigning phone_numbers REPLACES the array, deleting the organisation number
  // Apollo enriched on its own. direct_phone appends.
  check('it never replaces phone_numbers wholesale', patch.phone_numbers === undefined);
  check('and it does not resend the title', patch.title === undefined);
}

console.log('\nIt claims nothing it was not given');
{
  // Custom fields now ride the follow-up write too, because bulk_create refuses to
  // update them on a contact it already has — so "nothing to send" means no owner,
  // no phone, no label AND no custom fields.
  const bare = { ...contact, phone: null, ownerId: null, label: null, customFields: {} };
  check('nothing given at all produces an empty patch', Object.keys(buildDetailPatch(bare, null)).length === 0);
  check('a phone alone produces only a phone', JSON.stringify(buildDetailPatch({ ...bare, phone: '+1 555 0001' }, null)) === '{"direct_phone":"+1 555 0001"}');
  check('an unresolved label adds nothing', buildDetailPatch({ ...bare, ownerId: null, phone: null }, null).label_ids === undefined);
}

console.log('\nCustom fields are refreshed on a contact Apollo already has');
{
  /*
    The regression this guards: a corrected call script or a re-rendered brief
    could never reach a contact that had been sent once, because bulk_create
    returns it as `existing` with every custom field untouched. Re-sending
    reported success and changed nothing.
  */
  const only = buildDetailPatch({ ...contact, phone: null, ownerId: null, label: null }, null);
  check('custom fields alone still produce a patch', Object.keys(only).length === 1, JSON.stringify(Object.keys(only)));
  check('and it carries them', only.typed_custom_fields?.['field-id'] === LONG);
  const full = buildDetailPatch(contact, 'label-abc');
  check(
    'alongside owner, phone and list',
    Boolean(full.owner_id && full.direct_phone && full.label_ids && full.typed_custom_fields)
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
