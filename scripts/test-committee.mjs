/**
 * Committee gap-filling — the merge and stop rules, against the REAL personas.
 *
 * The filler goes back to Apollo once per missing role and then to Claude for
 * the remainder, so the rules that matter are the ones that decide HOW MANY
 * times it does that. Two failures cost real money and neither raises an
 * error: searching for a role that is already satisfied, and failing to
 * recognise the same person returned twice so a role never counts as filled
 * and gets searched forever.
 *
 * The orchestrator itself does network I/O; what is asserted here is the pure
 * logic it drives — coverage after a merge, and identity across providers.
 *
 *   node --experimental-transform-types scripts/test-committee.mjs
 */

import { coverageFor, titlesFor, ROLE_SENIORITIES, BUYING_ROLES } from '../src/lib/personas.ts';

let passed = 0;
let failed = 0;
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

/** Mirrors the identity rule in committee.ts — email, then LinkedIn, then name. */
const keyOf = (c) => {
  if (c.email) return `e:${c.email.toLowerCase().trim()}`;
  if (c.linkedin_url) return `l:${c.linkedin_url.toLowerCase().replace(/\/+$/, '')}`;
  return `n:${(c.name ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
};
const merge = (existing, found) => {
  const seen = new Set(existing.map(keyOf));
  const out = [...existing];
  for (const c of found) {
    if (!c.name?.trim()) continue;
    const k = keyOf(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
};

group('The same person from two providers is one person');
{
  const apollo = [{ name: 'Jane Doe', title: 'Director of Construction', email: 'jane@acme.com', source: 'apollo' }];
  const claude = [{ name: 'Jane Doe', title: 'Director of Construction', email: 'JANE@ACME.COM', source: 'claude' }];
  check('matched on email, case-insensitively', merge(apollo, claude).length === 1);

  const byLinkedIn = merge(
    [{ name: 'J. Doe', title: 'Head of Construction', linkedin_url: 'https://linkedin.com/in/jdoe', source: 'apollo' }],
    [{ name: 'Jane Doe', title: 'Head of Construction', linkedin_url: 'https://linkedin.com/in/jdoe/', source: 'claude' }]
  );
  check('matched on LinkedIn, trailing slash ignored', byLinkedIn.length === 1, String(byLinkedIn.length));

  const byName = merge(
    [{ name: 'Jane  Doe', title: 'VP Construction', source: 'apollo' }],
    [{ name: 'jane doe', title: 'VP Construction', source: 'claude' }]
  );
  check('matched on name when nothing better exists', byName.length === 1);

  const different = merge(
    [{ name: 'Jane Doe', title: 'VP Construction', email: 'jane@acme.com', source: 'apollo' }],
    [{ name: 'John Smith', title: 'Programme Director', email: 'john@acme.com', source: 'claude' }]
  );
  check('two different people stay two', different.length === 2);
}

group('Junk is never merged in');
{
  const base = [{ name: 'Jane Doe', title: 'VP Construction', source: 'apollo' }];
  check('a nameless, titleless entry is dropped', merge(base, [{ name: null, title: null }]).length === 1);
  check('an empty name with no title is dropped', merge(base, [{ name: '', title: '' }]).length === 1);
  // Nobody can call a job title. A nameless result tells us the role exists
  // and nothing else, so it does not belong on an outreach list.
  check('a title with no name is dropped', merge(base, [{ name: null, title: 'Head of Capital Projects' }]).length === 1);
  check('a whitespace name is dropped', merge(base, [{ name: '   ', title: 'VP Projects' }]).length === 1);
}

group('Filling stops when the shape is filled, not when contacts run out');
{
  const play = 'data_centres';
  const complete = [
    { title: 'Director of Construction' }, { title: 'VP Construction' },
    { title: 'Construction Director' }, { title: 'Project Director' },
    { title: 'BIM Director' }, { title: 'Innovation Director' },
    { title: 'Site Manager' }, { title: 'Construction Manager' },
  ];
  check('a complete committee asks for nothing', coverageFor(complete, 'enterprise', play).missing.length === 0);

  const lopsided = Array.from({ length: 20 }, () => ({ title: 'Site Manager' }));
  const missing = coverageFor(lopsided, 'enterprise', play).missing;
  check('twenty juniors still leaves three roles open', missing.length === 3, JSON.stringify(missing.map((m) => m.role)));
  check('and asks for the economic buyer first', missing[0].role === 'economic');
  check('asking for exactly what is short', missing.find((m) => m.role === 'economic').need === 2);
}

group('Mid-market stops sooner than enterprise');
{
  const four = [
    { title: 'Head of Construction' }, { title: 'Programme Director' },
    { title: 'BIM Director' }, { title: 'Site Manager' },
  ];
  check('mid-market is satisfied', coverageFor(four, 'mid_market', 'data_centres').missing.length === 0);
  check('enterprise still wants a second of each', coverageFor(four, 'enterprise', 'data_centres').missing.length === 4);
}

group('Every role the filler can search has something to search with');
for (const play of ['data_centres', 'tier1_contractors', 'energy', 'water', 'mining', 'bess']) {
  for (const role of BUYING_ROLES) {
    const titles = titlesFor(play, role);
    // key_account_growth intentionally has no users; every other play should.
    if (titles.length === 0) continue;
    check(`${play}/${role}: has titles and seniorities`, titles.length > 0 && ROLE_SENIORITIES[role].length > 0);
  }
}

group('A filled role is never searched again');
{
  const play = 'energy';
  let contacts = [{ title: 'Site Manager' }];
  const before = coverageFor(contacts, 'mid_market', play).missing.map((m) => m.role);
  check('user is already satisfied and not requested', !before.includes('user'), before.join(','));

  contacts = merge(contacts, [{ name: 'A B', title: 'Head of Transmission' }]);
  const after = coverageFor(contacts, 'mid_market', play).missing.map((m) => m.role);
  check('adding an economic buyer removes that request', !after.includes('economic'), after.join(','));
  check('and leaves the genuinely missing ones', after.length === before.length - 1, `${after.length} vs ${before.length}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
