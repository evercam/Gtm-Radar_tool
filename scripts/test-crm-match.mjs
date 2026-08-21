/**
 * Which CRM account a lead's company is, and when to refuse to say.
 *
 *   node --experimental-transform-types --no-warnings \
 *     --import ./scripts/lib/register-alias.mjs scripts/test-crm-match.mjs
 *
 * Every fixture here is real. The names, the duplicate accounts, the junk rows and
 * the substring collision were all taken from the live Zoho org while measuring
 * whether this feature was worth building, and the cases are weighted toward the
 * three ways it can put a wrong flag in front of a rep:
 *
 *   A WRONG `Avoid`. The costliest failure and a silent one. It tells somebody a
 *     live prospect is on a do-not-call list, and the lead simply never gets
 *     worked. Nothing downstream reports it.
 *
 *   ONE OF SIX TURNERS. `Turner Construction`, `Turner & Townsend`, `Turner
 *     Industries Group`, `Turner Publishing`, `Mark Turner Construction`,
 *     `Thompson Turner Construction` — six companies, one word.
 *
 *   A PUBLIC SUFFIX AS A DOMAIN. Reducing `bandk.co.uk` to `co.uk` would match
 *     every British company in the CRM to every other one at once.
 */

import {
  crmDomain,
  looksLikePerson,
  isMatchable,
  buildCrmIndex,
  matchCrmAccount,
  crmSignal,
} from '@/lib/crm/accountMatch';

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

const acc = (id, name, accountType, website = null) => ({ id, name, accountType, website });

group('A website field holds whatever a human typed into it');
{
  check('a bare host', crmDomain('savills.ie') === 'savills.ie');
  check('a full url', crmDomain('https://www.johnpaul.ie') === 'johnpaul.ie');
  check('a deep path is discarded', crmDomain('https://gb.gleeds.com/sectors/data-centres/') === 'gleeds.com');

  /*
    All four of these are verbatim from the live Accounts module. None may throw
    and none may produce a domain that matches an unrelated company.
  */
  check('the doubled scheme really in the Active list', crmDomain('www.http://virtuspm.ie') === 'virtuspm.ie');
  check('an email address in the website field', crmDomain('kayble@me.com') === null, String(crmDomain('kayble@me.com')));
  check(
    'a Microsoft entry that is an Outlook deeplink',
    crmDomain('https://www.microsoft.com/en-us/microsoft-365/outlook/email-and-calendar-software-microsoft-outlook?deeplink=%2fowa%2f&sdf=0') === 'microsoft.com'
  );
  check('a typo host still reduces', crmDomain('ww.seanlaceyltd.com') === 'seanlaceyltd.com');

  /*
    The load-bearing case. Two labels is the wrong answer for a British company,
    and the wrong answer here is not a miss — it is one bucket holding every
    .co.uk account in the CRM.
  */
  check('a UK company keeps its own name', crmDomain('https://www.bandk.co.uk/') === 'bandk.co.uk');
  check('an Australian one too', crmDomain('nc-electrical.com.au') === 'nc-electrical.com.au');
  check('a bare public suffix is not a company', crmDomain('co.uk') === null);
  check('free mail is not a company', crmDomain('someone@gmail.com') === null);
  check('nothing in, nothing out', crmDomain(null) === null && crmDomain('') === null && crmDomain('not a url') === null);
}

group('People are not companies, but company names contain people');
{
  // Verbatim from `Forget it / Junk / Avoid` — web-form leads sitting in Accounts.
  check('a plain personal name', looksLikePerson('Leon Blaq'));
  check('another', looksLikePerson('Sven Hemmingsson'));
  check('and another', looksLikePerson('Andy Zhang'));

  /*
    The other half of the rule, and the reason it is deliberately narrow. These are
    real construction firms sitting in that same list, and treating them as people
    would drop genuine do-not-call entries.
  */
  check("O'Brien is a builder here", !looksLikePerson("Thomas O'Brien Construction"));
  check('so is Curran', !looksLikePerson('John Curran & Sons'));
  check('and Michael Bennett', !looksLikePerson('Michael Bennett Group'));
  check('a single word is not a person', !looksLikePerson('Ardmac'));

  check('an account with no type carries no verdict', !isMatchable(acc('1', 'Some Firm Ltd', null)));
  check('a typed company is matchable', isMatchable(acc('2', 'Ardmac', 'Lapsed')));
  check('a person is never matchable', !isMatchable(acc('3', 'Leon Blaq', 'Forget it / Junk / Avoid')));
}

group('Six Turners, one word');
{
  const turners = [
    acc('t1', 'Turner Construction', 'Lapsed', 'tcco.com'),
    acc('t2', 'Turner & Townsend UK', 'Friend ( Relevant, but not a direct buyer)', 'turnerandtownsend.com'),
    acc('t3', 'Turner Industries Group', 'Qualified'),
    acc('t4', 'Turner Publishing Inc.', 'Customer - To Be Qualified', 'turnerpublishing.net'),
    acc('t5', 'Mark Turner Construction', 'Qualified'),
    acc('t6', 'Thompson Turner Construction', 'To Be Qualified', 'thompsonturner.com'),
  ];
  const idx = buildCrmIndex(turners);

  const byDomain = matchCrmAccount({ companyName: 'Turner Construction Company', domain: 'tcco.com' }, idx);
  check('a domain picks the right Turner', byDomain.status === 'matched' && byDomain.account?.id === 't1');
  check('and says so with confidence', byDomain.confidence === 'high');
  check('and it is the Lapsed one, which is the whole point', crmSignal(byDomain.account?.accountType) === 'lapsed');

  /*
    `Turner Construction` and `Turner Construction Company` normalise to the same
    key — `company` is a legal suffix — so this is a single exact-name hit and is
    allowed. It is still only a name, so it never reaches high confidence.
  */
  const byName = matchCrmAccount({ companyName: 'Turner Construction Company' }, idx);
  check('without a domain the name still resolves', byName.status === 'matched' && byName.account?.id === 't1');
  check('but never at high confidence', byName.confidence !== 'high', byName.confidence);

  // The near-names must not collapse into it.
  check('Mark Turner is a different company', matchCrmAccount({ companyName: 'Mark Turner Construction' }, idx).account?.id === 't5');
  check('so is Thompson Turner', matchCrmAccount({ companyName: 'Thompson Turner Construction' }, idx).account?.id === 't6');
  check('a bare surname matches nobody', matchCrmAccount({ companyName: 'Turner' }, idx).status === 'no_match');
}

group('The same company entered twice');
{
  /*
    Both of these are live. Duplicates are safe to collapse only while they agree
    on the verdict, because the verdict is the entire payload.
  */
  const agreeing = buildCrmIndex([
    acc('h1', 'BL Harbert International', 'Customer - To Be Qualified'),
    acc('h2', 'BL Harbert International LLC', 'Customer - To Be Qualified', 'blharbert.com'),
  ]);
  const m = matchCrmAccount({ companyName: 'BL HARBERT INTERNATIONAL LLC' }, agreeing);
  check('duplicates that agree still answer', m.status === 'matched');
  check('but only at low confidence', m.confidence === 'low');
  check('and both are kept for a human to see', m.candidates.length === 2);

  const disagreeing = buildCrmIndex([
    acc('d1', 'Acme Construction', 'Active'),
    acc('d2', 'Acme Construction Ltd', 'Forget it / Junk / Avoid'),
  ]);
  const d = matchCrmAccount({ companyName: 'Acme Construction' }, disagreeing);
  check('duplicates that disagree refuse', d.status === 'ambiguous');
  check('and name no account at all', d.account === null);
  check('a caller cannot mistake it for a hit', d.status !== 'matched');
  check('the reason says what happened', /disagree/.test(d.reason), d.reason);
}

group('The false positive that started this');
{
  /*
    Our UK `ENVIRONMENT AGENCY` matched `National Environment Agency (NEA)
    Singapore` when probing the CRM with a substring search. Different continent,
    different organisation. Exact-key matching is what prevents it, and this case
    exists so nobody reintroduces a `contains` shortcut later.
  */
  const idx = buildCrmIndex([acc('s1', 'National Environment Agency (NEA) Singapore', 'Qualified', 'nea.gov.sg')]);
  const m = matchCrmAccount({ companyName: 'ENVIRONMENT AGENCY' }, idx);
  check('a substring is not a match', m.status === 'no_match', `${m.status} -> ${m.account?.name}`);
}

group('What a rep should do about it');
{
  check('avoid', crmSignal('Forget it / Junk / Avoid') === 'avoid');
  check('current customer', crmSignal('Active') === 'customer');
  check('warm re-entry', crmSignal('Lapsed') === 'lapsed');
  check('installer', crmSignal('Installation Partner') === 'partner');
  check('an investor is not a prospect', crmSignal('VC / Evercam Investor') === 'partner');
  check('everything else is merely known', crmSignal('Qualified') === 'known');
  check('and no type is not a signal', crmSignal(null) === 'none' && crmSignal('') === 'none');
}

group('An index built from the live junk');
{
  const idx = buildCrmIndex([
    acc('a', 'Bowmer & Kirkland', 'Active', 'https://www.bandk.co.uk/'),
    acc('b', 'Leon Blaq', 'Forget it / Junk / Avoid'),
    acc('c', 'Untyped Firm Ltd', null, 'untyped.com'),
    acc('d', 'Ardmac', 'Lapsed', 'www.ardmac.com'),
  ]);
  check('junk and untyped rows are excluded', idx.size === 2, `size ${idx.size}`);
  check('and counted rather than silently dropped', idx.skipped === 2, `skipped ${idx.skipped}`);
  check('the UK domain indexed under its own name', idx.byDomain.has('bandk.co.uk'));
  check('not under the public suffix', !idx.byDomain.has('co.uk'));

  const m = matchCrmAccount({ companyName: 'Bowmer and Kirkland Ltd' }, idx);
  check('an ampersand spelled out still matches', m.status === 'matched' && m.account?.id === 'a', m.reason);
  check('an unknown company is a clean miss', matchCrmAccount({ companyName: 'Nobody Plc' }, idx).status === 'no_match');
  check('no company name at all is a miss, not a crash', matchCrmAccount({ companyName: null }, idx).status === 'no_match');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
