/**
 * Scoring fit lists — against the REAL src/lib/policyFields.ts.
 *
 * These were free-text boxes holding raw icp_code values, so a typo silently
 * scored every matching record lower with nothing to show why. As choices,
 * the risk inverts: the list must offer everything the data actually contains,
 * or a value that exists becomes unselectable and its records lose the weight.
 *
 *   node --experimental-transform-types scripts/test-scoring-fields.mjs
 */

import { scoringFields } from '../src/lib/policyFields.ts';
import { ICP_LABELS, VERTICALS } from '../src/lib/semantics.ts';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const group = (n) => console.log(`\n${n}`);
const field = (fs, path) => fs.find((f) => f.path === path);
const values = (f) => (f.choices ?? []).map((c) => c.value);

group('The fit lists are pickable, not typed');
{
  const fs = scoringFields();
  for (const path of ['strategicIcps', 'secondaryIcps', 'coreVerticals']) {
    const f = field(fs, path);
    check(`${path} exists`, Boolean(f));
    check(`${path} is a multiselect`, f?.kind === 'multiselect', f?.kind);
    check(`${path} offers choices`, (f?.choices?.length ?? 0) > 0);
    check(`${path} says what empty means`, Boolean(f?.emptyLabel));
    check(`${path} every choice has a label`, (f?.choices ?? []).every((c) => c.label?.trim().length > 0));
  }
}

group('Known vocabulary is always offered');
{
  const fs = scoringFields();
  const icps = values(field(fs, 'strategicIcps'));
  check('every known ICP is offered', Object.keys(ICP_LABELS).every((k) => icps.includes(k)), icps.join(','));
  const verts = values(field(fs, 'coreVerticals'));
  check('every known vertical is offered', VERTICALS.every((v) => verts.includes(v)));
  check('ICPs are labelled, not raw codes', field(fs, 'strategicIcps').choices.some((c) => c.label !== c.value));
}

group('Values present in the data are offered even if unknown to the code');
{
  const fs = scoringFields({ icp: ['brand_new_icp'], vertical: ['fusion'] });
  check('an unseen ICP appears', values(field(fs, 'strategicIcps')).includes('brand_new_icp'));
  check('an unseen vertical appears', values(field(fs, 'coreVerticals')).includes('fusion'));
  check('it is titleised for display', field(fs, 'coreVerticals').choices.find((c) => c.value === 'fusion').label === 'Fusion');
}

group('Choices are clean');
{
  const fs = scoringFields({ icp: ['tier1_gc', 'tier1_gc'], vertical: ['solar'] });
  const icps = values(field(fs, 'strategicIcps'));
  check('a value present in both code and data is not duplicated', icps.filter((v) => v === 'tier1_gc').length === 1);
  check('verticals are not duplicated', values(field(fs, 'coreVerticals')).filter((v) => v === 'solar').length === 1);
  check('choices are sorted', icps.join() === [...icps].sort((a, b) => a.localeCompare(b)).join());
  check('strategic and secondary offer the same vocabulary', values(field(fs, 'secondaryIcps')).join() === icps.join());
}

group('The rest of the editor is untouched');
{
  const fs = scoringFields();
  for (const path of ['weights.timing', 'weights.icpFit', 'bands.P1', 'valueSaturation', 'deadPhaseCap']) {
    check(`${path} still present`, Boolean(field(fs, path)));
  }
  check('no duplicate paths', new Set(fs.map((f) => f.path)).size === fs.length);
  check('every field names a group', fs.every((f) => f.group?.trim().length > 0));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
