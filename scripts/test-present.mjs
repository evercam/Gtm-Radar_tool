/**
 * Rendering a tool result — against the real src/lib/mcp/present.ts.
 *
 * These are not cosmetic assertions. Three of them protect against a table that
 * still LOOKS like a table while saying something false:
 *
 *   - an unescaped pipe shifts every later column left, so a row silently reports
 *     the wrong values under the right headings;
 *   - an empty scope array means "no restriction", so a blank cell would state the
 *     exact opposite of the truth about who receives leads;
 *   - a currency dropped from an amount turns three currencies into one column of
 *     meaningless numbers.
 *
 * The rest pin the shape-driven behaviour, which is the whole design: a tool that
 * gains a field must get a column for free rather than have it dropped.
 *
 *   node --experimental-transform-types scripts/test-present.mjs
 */

const { presentResult, presentError } = await import('../src/lib/mcp/present.ts');

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

group('A list of records becomes a table');
const search = presentResult({
  count: 2,
  truncated: false,
  projects: [
    {
      id: 'uuid-1',
      ref: 'UK-PROC-GB-FA028C0C',
      name: 'Royal Free Hospital refurbishment',
      company: 'Kier Group',
      accountKey: 'kier-group',
      phase: 'pre_construction',
      phaseRaw: 'Pre-Construction (Design)',
      band: 'P1',
      score: 87,
      value: 4200000,
      currency: 'GBP',
      reachable: true,
      exportedAt: null,
    },
    {
      id: 'uuid-2',
      ref: 'USA-PROC-US-7FA612FB',
      name: 'Austin data centre',
      company: 'Turner Construction',
      accountKey: 'turner',
      phase: 'tender',
      phaseRaw: 'Tender',
      band: 'P2',
      score: 64,
      value: 18000000,
      currency: 'USD',
      reachable: false,
      exportedAt: '2026-08-11T09:14:00Z',
    },
  ],
});
check('a header row is emitted', search.includes('| Ref | Name |'), search.split('\n')[2]);
check('there is an alignment rule', /\| ---/.test(search) || /\| --:/.test(search));
check('one line per record plus header and rule', search.split('\n').filter((l) => l.startsWith('|')).length === 4);
check('the identifying column comes first', /\|\s*Ref\s*\|/.test(search.split('\n').find((l) => l.includes('Ref'))));
check('scalars become a summary line, not a row', search.includes('**Count:** 2'));

group('Money keeps its currency — three currencies must not become one column');
check('GBP renders with its symbol', search.includes('£4,200,000'), search);
check('USD renders with its symbol', search.includes('$18,000,000'));
const unknownCurrency = presentResult({ rows: [{ name: 'x', value: 1000, currency: 'ZWL' }] });
check('an unknown currency code is kept, not dropped', unknownCurrency.includes('1,000 ZWL'), unknownCurrency);
const noCurrency = presentResult({ rows: [{ name: 'x', value: 1000 }] });
check('a bare amount still renders', noCurrency.includes('1,000'));

group('Redundant columns are dropped but the data is not lost');
check('the raw phase is not a column', !search.includes('Phase Raw'));
check('the normalised phase is', search.includes('pre_construction'));
check('the uuid is not a column', !search.includes('| Id |'));
// Dropped from the TABLE only. structuredContent still carries them, which is why
// dropping them here is a presentation choice rather than data loss.
check('the account key is not a column', !search.includes('Account Key'));

group('Timestamps and booleans');
check('a date is rendered as a date', search.includes('2026-08-11'));
check('a time is not shown where a date is enough', !search.includes('09:14'));
check('true becomes yes', search.includes('yes'));
check('null becomes a dash, not the word null', search.includes('—') && !search.includes('null'));
const runs = presentResult({ runs: [{ startedAt: '2026-08-17T06:17:19Z', status: 'failed', durationMs: 25903 }] });
check('a run start keeps its time — two runs a day are otherwise identical', runs.includes('2026-08-17 06:17'), runs);
check('a duration is human-readable', runs.includes('25.9s'), runs);
const long = presentResult({ runs: [{ durationMs: 137287 }] });
check('a long duration is minutes and seconds', long.includes('2m 17s'), long);

group('A pipe in the data must not corrupt the row');
/*
  The failure this prevents: an unescaped pipe ends the cell early, so every later
  column shifts one place left. The row still parses as a row — it just reports the
  wrong value under each heading, which is worse than not rendering.
*/
const piped = presentResult({ rows: [{ name: 'Phase 1 | Phase 2', status: 'live' }] });
check('a pipe is escaped', piped.includes('Phase 1 \\| Phase 2'), piped);
const dataRow = piped.split('\n').filter((l) => l.startsWith('|'))[2];
check('the row still has the right number of cells', (dataRow.match(/(?<!\\)\|/g) || []).length === 3, dataRow);

const newlined = presentResult({ rows: [{ name: 'line one\nline two', status: 'live' }] });
check('a newline is flattened rather than breaking the table', newlined.includes('line one line two'), newlined);
check('no stray blank row is produced', newlined.split('\n').filter((l) => l.startsWith('|')).length === 3);

group('An empty scope array means EVERYTHING, and must not read as nothing');
/*
  list_assignees documents this: an empty bu/vertical/region list is no restriction
  on that axis. A dash here would say the person receives nothing, and somebody
  would go hunting for why they are being skipped.
*/
const roster = presentResult({
  count: 1,
  people: [{ name: 'Marco', active: true, dailyQuota: 20, bu: [], verticals: ['solar'], regions: [] }],
});
check('an empty bu reads as "any"', /\|\s*any\s*\|/.test(roster), roster);
check('a populated vertical still lists its values', roster.includes('solar'));
// A different empty array must NOT claim to be unrestricted.
const otherEmpty = presentResult({ rows: [{ name: 'x', tags: [] }] });
check('an unrelated empty array is a dash, not "any"', !otherEmpty.includes('any'), otherEmpty);

group('An empty list says so in words');
const none = presentResult({ count: 0, truncated: false, projects: [] });
check('no header-only table is emitted', !none.includes('|'), none);
check('it states the result plainly', none.includes('No projects matched'), none);

group('A single record becomes a field block, not a table');
const project = presentResult({
  id: 'uuid',
  ref: 'UK-PROC-GB-FA028C0C',
  name: 'Royal Free Hospital',
  company: 'Kier Group',
  phase: 'pre_construction',
  assignedTo: 'Marco',
  exportedAt: null,
  brief: 'WHY NOW\nThe trust has funding approved.\n\nFACTS\nValue £4.2m, tender closes 12 September.',
});
check('fields are a list', project.includes('- **Ref:**'), project.slice(0, 200));
check('no table is produced for one record', !project.split('\n').some((l) => l.startsWith('|')));
check('the brief gets its own section', project.includes('**Brief**'));
check('the brief keeps its line breaks', project.includes('> WHY NOW'), project);
check('the brief is not truncated into a cell', project.includes('tender closes 12 September'));

group('Nested objects and multiple lists are labelled');
const account = presentResult({
  accountKey: 'kier',
  name: 'Kier Group',
  projectCount: 3,
  enrichment: { parentAccount: 'Kier plc', expansionSignal: 'hiring', relatedEntities: 4 },
  projects: [{ ref: 'A-1', name: 'One', value: 100, currency: 'GBP' }],
});
check('the nested object is labelled', account.includes('**Enrichment**'), account);
check('its fields are listed', account.includes('- **Parent Account:** Kier plc'));
check('the project list is labelled when it shares the output', account.includes('**Projects**'));
check('the list is still a table', account.split('\n').some((l) => l.startsWith('| Ref')));

group('A field nobody planned for still renders');
/*
  The point of the shape-driven design. A tool that gains a column must get it for
  free — a registry keyed by tool name would keep rendering yesterday's columns.
*/
const novel = presentResult({ rows: [{ ref: 'X', somethingBrandNew: 'hello', anotherThing: 42 }] });
check('an unknown string field gets a column', novel.includes('Something Brand New'), novel);
check('its value is shown', novel.includes('hello'));
check('an unknown number field is formatted', novel.includes('42'));
check('labels are derived from the field name', novel.includes('Another Thing'));

group('Errors read as explanations');
const err = presentError({
  code: 'assignee_ambiguous',
  message: '"anas" matches 2 people.',
  details: { matches: ['Anas Filali', 'Anas Bennani'] },
});
check('the code is shown, because it is the greppable part', err.includes('Assignee ambiguous'), err);
check('the message is shown', err.includes('matches 2 people'));
check('the details are rendered too', err.includes('Anas Bennani'));
const bare = presentError({ code: 'not_found', message: 'No project for ref X.' });
check('an error with no details is still clean', bare.includes('Not found') && !bare.includes('undefined'), bare);

group('Degenerate inputs do not throw');
check('null', presentResult(null) === '_No result._');
check('an empty object', typeof presentResult({}) === 'string');
check('a bare array of objects', presentResult([{ a: 1 }]).includes('| A |'));
check('an array of scalars', presentResult(['a', 'b']).includes('- a'));
check('a string', presentResult('hello') === 'hello');
check('an empty array', presentResult([]) === '_Nothing to show._');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
