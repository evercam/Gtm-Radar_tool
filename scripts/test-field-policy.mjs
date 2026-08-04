/**
 * The Apollo field mapping is configuration, and configuration can be wrong.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-field-policy.mjs
 *
 * This mapping exists because two of the built-in defaults cannot work: `Qualify
 * Account` and `evercam_us_project_signal` are modality 'account', so Apollo
 * accepts them on a contact and silently discards them. Making the destination
 * editable is what lets someone fix that without a deploy — and introduces two new
 * ways to break the export, both asserted here:
 *
 *   two of our fields aimed at ONE Apollo field   the second overwrites the first
 *   a field switched off that turns itself back on a setting that does not stick
 *
 * Pure: no database, no network.
 */

import {
  DEFAULT_EXPORT_FIELD_POLICY,
  EXPORT_FIELD_SOURCES,
  mergeExportFieldPolicy,
  validateExportFieldPolicy,
  resolveFieldMap,
} from '@/lib/export/fieldPolicy';
import { FIELD_MAP } from '@/lib/export/apolloFields';

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

console.log('The defaults are exactly the built-in map');
{
  check('every source in FIELD_MAP has a default', FIELD_MAP.every((f) => DEFAULT_EXPORT_FIELD_POLICY[f.source] === f.apolloName));
  check('the source list matches FIELD_MAP', EXPORT_FIELD_SOURCES.length === FIELD_MAP.length);
  check('an empty document changes nothing', JSON.stringify(mergeExportFieldPolicy({})) === JSON.stringify(DEFAULT_EXPORT_FIELD_POLICY));
  check('a null document changes nothing', JSON.stringify(mergeExportFieldPolicy(null)) === JSON.stringify(DEFAULT_EXPORT_FIELD_POLICY));
}

console.log('\nOff means off — the setting has to stick');
{
  // The trap: treating null as "absent" makes a disabled field silently
  // re-enable itself on the next read, which is the opposite of a setting.
  const off = mergeExportFieldPolicy({ qualify_account: null });
  check('an explicitly disabled field stays disabled', off.qualify_account === null, JSON.stringify(off.qualify_account));
  check('disabling one field leaves the others alone', off.contact_title === DEFAULT_EXPORT_FIELD_POLICY.contact_title);
  check('an empty string is treated as off, not as a field named ""', mergeExportFieldPolicy({ qualify_account: '   ' }).qualify_account === null);
  check('a disabled field is dropped from the resolved map', !resolveFieldMap(off).some((f) => f.source === 'qualify_account'));
}

console.log('\nRe-pointing a field is the whole point');
{
  const moved = mergeExportFieldPolicy({ qualify_account: 'Qualify Contact Notes' });
  check('the new target is used', moved.qualify_account === 'Qualify Contact Notes');
  const resolved = resolveFieldMap(moved);
  check('the resolved map carries it', resolved.some((f) => f.source === 'qualify_account' && f.apolloName === 'Qualify Contact Notes'));
  check('the resolved map keeps every enabled source', resolved.length === Object.values(moved).filter(Boolean).length);
}

console.log('\nTwo of our fields cannot share one Apollo field');
{
  // Silently allowed, this reports seven fields written and six arriving.
  const clash = validateExportFieldPolicy({ qualify_account: 'Qualify Contact' });
  check('a duplicate target is rejected', !clash.ok, JSON.stringify(clash));
  check('the refusal names both sources', /qualify_account/.test(clash.error ?? '') && /qualify_contact/.test(clash.error ?? ''), clash.error);
  check('the refusal names the field they collide on', /Qualify Contact/.test(clash.error ?? ''), clash.error);
  // Two fields both switched OFF is not a collision.
  check(
    'two disabled fields are not a collision',
    validateExportFieldPolicy({ qualify_account: null, project_signal: null }).ok
  );
}

console.log('\nA document cannot invent fields the export does not produce');
{
  const bogus = validateExportFieldPolicy({ not_a_field: 'Job Title' });
  check('an unknown source is rejected', !bogus.ok, JSON.stringify(bogus));
  check('the refusal names it', /not_a_field/.test(bogus.error ?? ''), bogus.error);
  // Merge is the lenient half: a stale document must not break the export.
  check('merge ignores an unknown source instead of throwing', mergeExportFieldPolicy({ not_a_field: 'x' }).not_a_field === undefined);
  check('a non-string target is rejected', !validateExportFieldPolicy({ contact_title: 42 }).ok);
  check('an array is rejected', !validateExportFieldPolicy(['Job Title']).ok);
  check('a string is rejected', !validateExportFieldPolicy('Job Title').ok);
}

console.log('\nThe default document is itself valid');
{
  // If the built-in defaults could not pass validation, "Reset to defaults"
  // would be a button that saves nothing.
  const v = validateExportFieldPolicy(DEFAULT_EXPORT_FIELD_POLICY);
  check('defaults validate', v.ok, v.error);
  check('defaults contain no duplicate targets', v.ok);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
