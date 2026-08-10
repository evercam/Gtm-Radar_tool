/**
 * News becomes a lead only when four things are true at once.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-news-icp.mjs
 *
 * A project event, a building, a named company, and a country we sell in. Miss
 * any one and it is not a lead, and the point of checking before ingestion is
 * that roughly nine items in ten fail at least one.
 *
 * Every headline below came off the live Google News feed on 2026-08-09. The
 * traps are the valuable half: results announcements, awards ceremonies and
 * executive hires use exactly the vocabulary of a contract award, and they are
 * what a naive keyword filter fills the queue with.
 *
 * Pure — no network, no database.
 */

import { extractLead, extractCompany, extractValue, extractRegion, ICP_HUNTS } from '@/lib/news/icp';

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

const TIER1 = ICP_HUNTS.find((h) => h.icpCode === 'tier1_gc');
const OWNER = ICP_HUNTS.find((h) => h.icpCode === 'mission_critical_owner');

const wants = (title, yes, hunt = TIER1, desc = '') => {
  const r = extractLead(title, desc, hunt);
  check(`${yes ? 'LEAD' : 'drop'}  ${title.slice(0, 66)}`, r.isLead === yes, r.reason);
  return r;
};

console.log('The hunt covers every ICP, in both regions');
{
  check('five ICP hunts', ICP_HUNTS.length === 5, String(ICP_HUNTS.length));
  check('each has queries', ICP_HUNTS.every((h) => h.queries.length > 0));
  check('each names a vertical', ICP_HUNTS.every((h) => Boolean(h.vertical)));
  check('icp codes are distinct', new Set(ICP_HUNTS.map((h) => h.icpCode)).size === 5);
  // The codes must be the ones the rest of the app understands, or partyLabel
  // renders nothing and the record reads as an undifferentiated company.
  const KNOWN = ['tier1_gc', 'tier2_gc', 'mission_critical_owner', 'critical_infra_owner', 'developer'];
  check('every icp code is a real one', ICP_HUNTS.every((h) => KNOWN.includes(h.icpCode)));
}

console.log('\nReal announcements become leads');
{
  const a = wants('GRAHAM awarded contract for new Airedale Hospital in UK', true);
  check('  company is the contractor', a.company === 'GRAHAM', String(a.company));
  check('  region is the UK', a.region === 'uk', String(a.region));

  /*
    A known limitation, pinned rather than hidden.

    "X awards Y a contract" leads with the BUYER, so that is what comes out —
    here the client, not Bouygues. The company is still a real, named
    organisation worth researching, and it is on the owner side rather than the
    contractor side, so the record's icp_code is the thing that is wrong, not the
    name. Fixing it properly means parsing the sentence, which is a model call
    and deliberately out of scope for the free pre-ingestion pass.
  */
  const b = wants(
    'Jersey government awards Bouygues Construction a contract for new Overdale Acute Hospital',
    true,
    TIER1,
    'The London-based contractor will build the scheme.'
  );
  check('  a buyer-led headline yields the buyer', b.company === 'Jersey government', String(b.company));

  // Jersey is a Crown Dependency, not the UK — without the description placing
  // it in London, the same headline is correctly dropped.
  check(
    '  and is dropped when nothing places it in the UK',
    !extractLead('Jersey government awards Bouygues Construction a contract for new Overdale Acute Hospital', '', TIER1).isLead
  );

  wants('Aurora Contractors awarded contract for new Ronald McDonald House at Stony Brook Children’s Hospital, New York', true);
  wants('Skanska breaks ground on $450 million Texas data center campus', true, OWNER);
  wants('Turner Construction wins contract for Chicago school construction project', true);
}

console.log('\nThe traps a keyword filter falls for');
{
  /*
    Each of these contains an award verb and a construction noun, and none is a
    project. These are the reason extraction runs before ingestion rather than
    after — they would otherwise be rows in front of a rep.
  */
  wants('Balfour Beatty wins award for excellence in construction safety', false);
  wants('Kier shares jump as construction profit beats forecast, London', false);
  wants('Morgan Sindall appoints new chief executive for construction division, UK', false);
  // `appoints` is a project event (a council appoints a contractor), so the
  // executive-hire exclusion has to survive every way a title is introduced.
  wants('Kier names its new managing director for construction, London', false);
  wants('Balfour Beatty appoints a director of major projects, Manchester', false);
  // ...without swallowing the real thing.
  wants('Leeds City Council appoints Kier to build new secondary school', true);
  wants('Skanska sued over Texas hospital construction defects', false);
  wants('Top 50 construction contractors ranking 2026, United States', false);
  wants('Opinion: what the construction contract awards tell us about UK growth', false);
  wants('Construction industry faces skills shortage in Texas', false);
  // Defence procurement awards contracts in the same words. Observed live in a
  // Tier 2 construction hunt.
  wants('Hanwha Defense USA wins U.S. Navy NGLS contract', false);
}

console.log('\nA country we do not sell in is not a lead');
{
  // The reason region cannot be delegated to the feed: a US-locale query
  // returned every one of these.
  wants('Saudi German Hospital Expansion Project Advances Healthcare Capacity in Jeddah', false);
  wants('Construction Commences At New Mandurah Hospital, Australia', false);
  wants('$200k contract awarded for hospital roofwork - The BVI Beacon', false);
  check('a British Virgin Islands story is not the UK', extractRegion('British Virgin Islands hospital contract') === null);
  check('Dublin is not the UK', extractRegion('Dublin hospital contract awarded') === null);
  check('London is the UK', extractRegion('London hospital contract awarded') === 'uk');
  check('Texas is the USA', extractRegion('Texas data center') === 'usa');
  check('an unplaceable story is null', extractRegion('New hospital contract awarded') === null);
}

console.log('\nMoney, as a newspaper writes it');
{
  const v = (t) => extractValue(t);
  check('£150m', v('£150m scheme')?.value === 150_000_000, JSON.stringify(v('£150m scheme')));
  check('and its currency', v('£150m scheme')?.currency === 'GBP');
  check('$1.2 billion', v('$1.2 billion campus')?.value === 1_200_000_000);
  check('$450 million', v('$450 million data center')?.value === 450_000_000);
  check('€45 million', v('€45 million plant')?.currency === 'EUR');
  check('$200k', v('$200k contract')?.value === 200_000);
  check('commas survive', v('£1,250 million')?.value === 1_250_000_000);
  // Two figures: the larger is the programme, which is what merits the call.
  check('the larger figure wins', v('phase one £20m of a £300m programme')?.value === 300_000_000);
  // A bare small number in a headline is a price, not a project.
  check('a bare $500 is ignored', v('the $500 permit fee') === null, JSON.stringify(v('the $500 permit fee')));
  check('no money is null', v('contract awarded') === null);
}

console.log('\nThe company, not the publication');
{
  /*
    Google News appends " - Publication" to every title. Left in place, the
    publication becomes the lead — the single most damaging extraction error
    here, because enrichment would then go and research a newspaper.
  */
  check(
    'the publication is stripped',
    extractCompany('GRAHAM awarded contract for new Airedale Hospital - World Construction Network') === 'GRAHAM'
  );
  check(
    'a leading value is stripped',
    extractCompany('$200k contract awarded for hospital roofwork - The BVI Beacon') === null,
    String(extractCompany('$200k contract awarded for hospital roofwork - The BVI Beacon'))
  );
  check('a multi-word name survives', extractCompany('Bouygues Construction wins Overdale Hospital deal') === 'Bouygues Construction');
  check('a lower-case fragment is refused', extractCompany('a new contract awarded today') === null);
  check('no event verb means no company', extractCompany('Hospital construction in Leeds') === null);
}

console.log('\nTier is upgraded on evidence, never on which query found it');
{
  const tier2 = ICP_HUNTS.find((h) => h.icpCode === 'tier2_gc');
  /*
    A Tier 2 hunt that turns up Balfour Beatty has found a Tier 1. Filing it as
    Tier 2 because of the query that caught it would put a national contractor
    in a regional rep's queue.
  */
  const r = extractLead('Balfour Beatty awarded groundworks package for Leeds scheme', '', tier2);
  check('a named Tier 1 overrides the hunt', r.icpCode === 'tier1_gc', String(r.icpCode));
  const s = extractLead('Hallam Contracts awarded groundworks package for Leeds scheme', '', tier2);
  check('an unknown contractor keeps the hunt’s tier', s.icpCode === 'tier2_gc', String(s.icpCode));
}

console.log('\nThe vertical comes from the story when the story says so');
{
  const eq = (title, vertical, hunt = TIER1) => {
    const r = extractLead(title, '', hunt);
    check(`${String(vertical).padEnd(12)} <- ${title.slice(0, 48)}`, r.vertical === vertical, String(r.vertical));
  };
  eq('Vantage breaks ground on Texas data centre campus', 'data_center', OWNER);
  eq('Hensel Phelps awarded Arizona semiconductor fab construction', 'semiconductor', OWNER);
  eq('Panasonic breaks ground on Nevada gigafactory battery plant', 'battery', OWNER);
  eq('Balfour Beatty wins London solar farm construction contract', 'solar');
  // Nothing in the text: the hunt's own default stands.
  eq('Kier awarded Leeds school construction contract', 'construction');
}

console.log('\nAustralia is a region, not "elsewhere"');
{
  /*
    APAC is tested BEFORE the UK, because the two share city names. "Newcastle" is
    a British city and an Australian one, so a state name or an ASX ticker decides
    where a bare city cannot.

    Australia also had to come OUT of the elsewhere list, where it was a hard
    reject while only the USA and the UK were in scope.
  */
  check('Perth is APAC', extractRegion('Monadelphous secures construction contract with BHP, Perth') === 'apac');
  check('South Australia is APAC', extractRegion("Laing O'Rourke AUKUS contract South Australia") === 'apac');
  check('Sydney is APAC', extractRegion('Sydney metro station contract awarded') === 'apac');
  check('an ASX ticker is APAC', extractRegion('Monadelphous Group (ASX:MND) awarded contract') === 'apac');
  check('New Zealand counts as APAC', extractRegion('Auckland light rail contract awarded') === 'apac');

  // The collision that makes the ordering matter.
  check('Newcastle NSW is APAC', extractRegion('Newcastle NSW hospital contract awarded') === 'apac');
  check('Newcastle upon Tyne is still UK', extractRegion('Newcastle upon Tyne hospital contract awarded') === 'uk');

  // Still rejected: an AU-locale query returned every one of these.
  check('Taiwan is still elsewhere', extractRegion('Taoyuan Brown Line construction starts') === null);
  check('Canada is still elsewhere', extractRegion('Construction contract awarded for CancerCare Manitoba facility') === null);

  const au = extractLead('Monadelphous secures major construction contract with BHP, Perth', '', TIER1);
  check('a real Australian award becomes a lead', au.isLead && au.region === 'apac', JSON.stringify({ r: au.region, c: au.company }));
  check('  and names the contractor', au.company === 'Monadelphous', String(au.company));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
