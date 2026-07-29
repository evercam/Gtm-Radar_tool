/**
 * The search date window.
 *
 * Two mistakes are cheap to make here and expensive to have. Opening the
 * window three years back means every search — and every schedule saved from
 * one — re-pulls a source's entire history on each run. And a same-day window
 * must be treated as a real day rather than an inverted range, or "just
 * today", now the default, is refused outright.
 *
 *   node --experimental-transform-types scripts/test-date-window.mjs
 */

import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const group = (n) => console.log(`\n${n}`);

// Read the source rather than mirror it: a copy of the rule would drift.
const search = readFileSync('src/components/SourceSearch.tsx', 'utf8');
const ocds = readFileSync('src/lib/adapters/ocds.ts', 'utf8');

group('The window starts today by default');
{
  const fn = search.match(/function defaultSince\(\): string \{([\s\S]*?)\n\}/)?.[1] ?? '';
  check('defaultSince is defined', fn.length > 0);
  check('it returns today', /return today\(\);/.test(fn), fn.trim());
  check('it no longer subtracts days', !/86_?400_?000/.test(fn), fn.trim());
  check('today() is a plain ISO date', /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(search));
}

group('Resetting filters restores the same default');
check('clearFilters uses defaultSince', /setSince\(defaultSince\(\)\)/.test(search));

group('A same-day window is a real day, not an inverted range');
{
  const guard = ocds.match(/if \(from\.getTime\(\) ([<>=]+) to\.getTime\(\)\)/)?.[1];
  check('the guard exists', Boolean(guard), String(guard));
  check('it rejects only from AFTER to', guard === '>', `found "${guard}"`);
  check('equality is not rejected', guard !== '>=', 'a same-day search would be refused');
}

group('The day is still spanned end to end');
{
  const fmt = ocds.match(/function fmtNoZ[\s\S]*?\n\}/)?.[0] ?? '';
  check('from is start of day', /'from' \? 'T00:00:00'/.test(fmt) || /00:00:00/.test(fmt), fmt.trim().slice(0, 120));
  check('to is end of day', /23:59:59/.test(fmt), fmt.trim().slice(0, 120));
}

group('The UI cannot express an inverted window');
{
  check('the Since input is capped by Until', /max=\{until \|\| undefined\}/.test(search));
  check('the Until input is floored by Since', /min=\{since \|\| undefined\}/.test(search));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
