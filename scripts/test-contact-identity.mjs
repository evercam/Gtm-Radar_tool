/**
 * The contact block is one person — enforced.
 *
 *   node --experimental-transform-types --import ./scripts/lib/register-alias.mjs \
 *        scripts/test-contact-identity.mjs
 *
 * The first case is the real Northshore row. `contact_name` held an obfuscated
 * name from an earlier run, `contact_email` was empty, and a later enrichment
 * attached a different person's verified address to it. Every field passed its
 * own "only fill what is empty" check; the row named the wrong human.
 *
 * That failure is silent by construction — a name plus a verified address is
 * exactly what a good record looks like — so it has to be caught here.
 */

import { planEnrichmentApply } from '../src/lib/provenance.ts';

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

const contact = (over = {}) => ({
  name: 'Eric Welte',
  title: 'Corporate Director',
  email: 'eric.welte@clevelandcliffs.com',
  phone: null,
  linkedin_url: null,
  source: 'apollo',
  ...over,
});

console.log('\nThe Northshore case — a stranger must not inherit the name');
{
  const { updates } = planEnrichmentApply({ contact_name: 'Dan Sc***n' }, null, contact());
  check('no email is attached to the other person', updates.contact_email === undefined, `got ${updates.contact_email}`);
  check('the stored name is left alone', updates.contact_name === undefined);
  check('no title either — the block moves together', updates.contact_title === undefined);
}

console.log('\nAn empty record takes the whole person');
{
  const { updates } = planEnrichmentApply({}, null, contact());
  check('name lands', updates.contact_name === 'Eric Welte');
  check('email lands', updates.contact_email === 'eric.welte@clevelandcliffs.com');
  check('title lands', updates.contact_title === 'Corporate Director');
}

console.log('\nThe same person, better known');
{
  // Apollo masks from a fixed point, so the visible prefix is real.
  const { updates } = planEnrichmentApply({ contact_name: 'Chris Me***r' }, null, contact({ name: 'Chris Meyer', email: 'chris.meyer@clevelandcliffs.com' }));
  check('the masked name is upgraded, not kept', updates.contact_name === 'Chris Meyer', `got ${updates.contact_name}`);
  check('and their own address lands', updates.contact_email === 'chris.meyer@clevelandcliffs.com');
}
{
  const { updates } = planEnrichmentApply(
    { contact_name: 'Eric Welte', contact_email: 'eric.welte@clevelandcliffs.com' },
    null,
    contact({ title: 'Corporate Director', phone: '+12166945700' })
  );
  check('gaps still fill for a match on address', updates.contact_phone === '+12166945700');
}

console.log('\nAmbiguity resolves to leaving the record alone');
{
  const { updates } = planEnrichmentApply({ contact_email: 'someone.else@clevelandcliffs.com' }, null, contact());
  check('a different address blocks the write', updates.contact_name === undefined);
}
{
  // A short prefix is not distinctive — "j***n" matches half a company.
  const { updates } = planEnrichmentApply({ contact_name: 'J***n' }, null, contact({ name: 'John Kelly' }));
  check('a short masked prefix is not a match', updates.contact_name === undefined, `got ${updates.contact_name}`);
}
{
  const { updates } = planEnrichmentApply({ contact_name: 'Dan Schneider' }, null, contact({ email: null }));
  check('a name against no address proves nothing', updates.contact_title === undefined);
}

console.log('\nThe switchboard is the company, not the person');
{
  const { updates } = planEnrichmentApply({ contact_name: 'Dan Sc***n' }, { phone: '+12166945700' }, contact());
  check('a main line still fills an empty phone', updates.contact_phone === '+12166945700');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
