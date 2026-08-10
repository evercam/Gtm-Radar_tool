/**
 * Turning construction news into leads, one ICP at a time.
 *
 * The other sources answer "what has been published in this register". This one
 * answers "who just announced a project", which is earlier and messier: a
 * headline is prose, not a record, and most of it is not a project at all.
 *
 * Two things follow from that, and they shape everything here.
 *
 * FIRST: the search is driven per ICP rather than as one generic sweep. A Tier 1
 * contractor, a data-centre owner and a housing developer are found by different
 * words, and a single "construction news" query returns mostly the biggest
 * builders and nothing else. So the loop is ICP × region × query, and each ICP
 * carries its own vocabulary and its own default vertical.
 *
 * SECOND: the extraction has to happen BEFORE ingestion. A news item is only a
 * lead if somebody can be sold to — a named company, a real project event, and a
 * country we sell in. Writing every headline into canonical_projects and sorting
 * it out later would put thousands of unqualified rows in front of reps, and the
 * queue is only worth opening if what is in it is real.
 *
 * The country check is not optional and cannot be delegated to the feed. Google
 * News honours `gl=US` and `gl=GB` as a ranking hint, not a filter — a single
 * verified query for US hospital awards returned projects in Saudi Arabia,
 * Australia and the British Virgin Islands. Region is therefore derived from the
 * text, and anything that cannot be placed in the USA or the UK is dropped.
 */

export type NewsRegion = 'usa' | 'uk' | 'apac';

/** What kind of company we are hunting, and what to search for to find them. */
export interface IcpHunt {
  icpCode: string;
  label: string;
  /** Default vertical for records found this way, when the text says nothing better. */
  vertical: string;
  /** Query fragments, combined with the project-event words below. */
  queries: string[];
}

/**
 * The loop.
 *
 * Ordered by how reliably each produces a usable lead, because a run may be cut
 * short by its record budget and the first ICP should be the best one.
 */
export const ICP_HUNTS: IcpHunt[] = [
  {
    icpCode: 'tier1_gc',
    label: 'Tier 1 GC',
    vertical: 'construction',
    queries: [
      'main contractor appointed construction',
      'awarded construction contract hospital',
      'awarded contract school construction',
      'design and build contract awarded',
    ],
  },
  {
    icpCode: 'tier2_gc',
    label: 'Tier 2 GC',
    vertical: 'construction',
    queries: ['subcontractor awarded package construction', 'groundworks contract awarded', 'fit-out contract awarded'],
  },
  {
    icpCode: 'mission_critical_owner',
    label: 'Mission-Critical Owner',
    vertical: 'data_center',
    queries: [
      'data center construction begins',
      'data centre breaks ground',
      'semiconductor fab construction',
      'battery gigafactory construction begins',
    ],
  },
  {
    icpCode: 'critical_infra_owner',
    label: 'Critical Infrastructure Owner',
    vertical: 'power',
    queries: [
      'solar farm construction begins',
      'wind farm construction contract',
      'water treatment plant construction contract',
      'rail station construction contract awarded',
    ],
  },
  {
    icpCode: 'developer',
    label: 'Developer',
    vertical: 'construction',
    queries: [
      'developer breaks ground residential scheme',
      'planning approved mixed-use development construction',
      'warehouse development construction begins',
    ],
  },
];

/** Google News search RSS for one query in one region. Keyless. */
const LOCALES: Record<NewsRegion, { hl: string; gl: string; ceid: string }> = {
  usa: { hl: 'en-US', gl: 'US', ceid: 'US:en' },
  uk: { hl: 'en-GB', gl: 'GB', ceid: 'GB:en' },
  apac: { hl: 'en-AU', gl: 'AU', ceid: 'AU:en' },
};

export function newsFeedUrl(query: string, region: NewsRegion): string {
  const locale = LOCALES[region];
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=${locale.hl}&gl=${locale.gl}&ceid=${locale.ceid}`;
}

/* -------------------------------------------------------------------------- */
/* Pre-ingestion extraction                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A project EVENT, not merely the word "construction".
 *
 * "Construction industry faces skills shortage" is not a lead. What makes a
 * headline actionable is that something specific has happened to a specific
 * job — it was awarded, it broke ground, it was approved, it started.
 */
const PROJECT_EVENT =
  /\b(award(?:s|ed)|wins?|won|lands?|bags?|clinches|secures?|appoints?|appointed|selects?|selected|breaks? ground|broke ground|groundbreaking|begins? construction|construction begins|starts? (?:on site|construction)|commences?|approved|greenlit|given the go-?ahead|to build|will build|plans? approved|contract for)\b/i;

/**
 * Text that names a construction project rather than a company's fortunes.
 *
 * Required alongside the event, because "wins award" and "secures funding" are
 * both events and neither is a building.
 */
const PROJECT_NOUN =
  /\b(construction|contract|scheme|development|project|facility|plant|factory|centre|center|hospital|school|campus|warehouse|data ?cent(?:re|er)|substation|bridge|tunnel|terminal|station|refurbishment|fit-?out|expansion|extension)\b/i;

/**
 * Headlines that match the words but are never a lead.
 *
 * Each of these was observed in a live feed. Results, rankings and market
 * commentary use exactly the vocabulary of an award, and share prices and legal
 * disputes are where the word "contract" appears most often of all.
 */
const NOT_A_PROJECT = [
  /\b(share price|shares? (?:rise|fall|jump|slump)|profit|revenue|results|earnings|dividend|takeover|acquisition|merger|ipo|stock)\b/i,
  /\b(lawsuit|sues?|court|tribunal|fined|inquiry|investigation|collapse|administration|insolven|liquidat|redundanc|job cuts|strike)\b/i,
  /\b(award(?:s|ed)? (?:for|to) excellence|wins? award|shortlist|nominat|ranking|top \d+|best places?|survey|report finds|index)\b/i,
  /*
    An executive hire, not a project.

    The adjectives have to be optional-and-repeatable: "appoints new chief
    executive" and "appoints its new managing director" both intervene between
    the verb and the title, and a pattern demanding them adjacent misses every
    real headline. This one matters more since `appoints` became a project event
    — a council appointing a contractor and a builder appointing a CFO are the
    same three words up to that noun.
  */
  /\b(appoints?|names?|hires?)\s+(?:a\s+|an\s+|the\s+|new\s+|its\s+|their\s+)*(?:chief|ceo|cfo|coo|cto|president|director|head of|managing director|chair)/i,
  /\b(new ceo|promotion|joins? (?:as|the board)|steps? down|retires?)\b/i,
  /\b(opinion|analysis|explainer|podcast|webinar|how to|guide to|five things|what to know)\b/i,
  /*
    Defence and IT procurement award contracts too, and "wins … contract" reads
    identically to a building award. "Hanwha Defense USA wins U.S. Navy NGLS
    contract" arrived inside a Tier 2 construction hunt.
  */
  /\b(navy|army|air force|marine corps|defen[cs]e contract|missile|weapons?|munitions|warship|submarine|satellite|software contract|it services contract)\b/i,
];

/** US state names and abbreviations are the cheapest reliable USA signal. */
const US_HINT =
  /\b(U\.?S\.?A?\b|United States|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|Wisconsin|Wyoming|Atlanta|Boston|Chicago|Dallas|Denver|Houston|Miami|Phoenix|Seattle|Brooklyn|Manhattan)\b/i;

/**
 * Australia and New Zealand, which the roster covers as the `apac` business unit.
 *
 * Checked before ELSEWHERE for the same reason the UK is: an AU-locale query
 * returned projects in Taiwan, Ontario, Manitoba and Gaza, so the locale is a
 * ranking hint and the text is the only evidence.
 */
const APAC_HINT =
  /\b(Australia|Australian|NSW|New South Wales|Victoria|Queensland|Tasmania|Northern Territory|Western Australia|South Australia|Sydney|Melbourne|Brisbane|Perth|Adelaide|Canberra|Hobart|Darwin|Newcastle NSW|Geelong|Gold Coast|Wollongong|Townsville|Cairns|New Zealand|Auckland|Wellington|Christchurch|ASX)\b/i;

const UK_HINT =
  /\b(U\.?K\.?\b|United Kingdom|Britain|British|England|Scotland|Wales|Northern Ireland|London|Manchester|Birmingham|Leeds|Glasgow|Edinburgh|Bristol|Liverpool|Sheffield|Cardiff|Belfast|Newcastle|Nottingham|Southampton|Aberdeen|NHS|council)\b/i;

/**
 * Places that are neither, and are the reason region cannot be left to the feed.
 *
 * A US-locale query returned projects in Saudi Arabia, Australia and the British
 * Virgin Islands. Checked FIRST, because "British Virgin Islands" contains
 * "British" and would otherwise read as the UK.
 */
const ELSEWHERE =
  /\b(Saudi|UAE|Dubai|Abu Dhabi|Qatar|Kuwait|Oman|Bahrain|India|China|Japan|Singapore|Malaysia|Indonesia|Vietnam|Philippines|Canada|Mexico|Brazil|Chile|Nigeria|Kenya|Egypt|South Africa|Germany|France|Spain|Italy|Netherlands|Belgium|Poland|Sweden|Norway|Denmark|Finland|Ireland|Dublin|Virgin Islands|Puerto Rico|Guam)\b/i;

/** Tier and party, when the text says so plainly. */
const TIER1_HINT =
  /\b(Balfour Beatty|Skanska|Laing O'?Rourke|Kier|Morgan Sindall|Galliford Try|BAM|Sir Robert McAlpine|Mace|Multiplex|Lendlease|Bouygues|VINCI|Ferrovial|Turner Construction|AECOM|Fluor|Bechtel|Jacobs|Whiting-?Turner|Clark Construction|Suffolk Construction|McCarthy|Gilbane|DPR|Hensel Phelps|Barton Malow|GRAHAM|Wates|ISG|Willmott Dixon)\b/i;

export interface NewsExtraction {
  /** Whether this is a lead at all. Everything else is only meaningful if true. */
  isLead: boolean;
  reason: string;
  region: NewsRegion | null;
  company: string | null;
  vertical: string | null;
  icpCode: string | null;
  /** Estimated value in the currency below, when the text states one. */
  value: number | null;
  currency: string | null;
}

/**
 * Money, as newspapers write it.
 *
 * "£150m", "$1.2 billion", "€45 million". Returns the largest figure found,
 * because a headline naming two numbers is usually contrasting a phase with the
 * whole programme, and the programme is the thing worth calling about.
 */
export function extractValue(text: string): { value: number; currency: string } | null {
  const re = /([£$€])\s?([\d,]+(?:\.\d+)?)\s*(bn|billion|m|million|k|thousand)?/gi;
  let best: { value: number; currency: string } | null = null;
  for (const m of text.matchAll(re)) {
    const symbol = m[1];
    const raw = Number(m[2].replace(/,/g, ''));
    if (!Number.isFinite(raw)) continue;
    const unit = (m[3] ?? '').toLowerCase();
    const scale = unit.startsWith('b') ? 1e9 : unit.startsWith('m') ? 1e6 : unit.startsWith('k') || unit.startsWith('t') ? 1e3 : 1;
    const value = raw * scale;
    // A bare "$500" in a headline is a price, not a project.
    if (!unit && value < 100_000) continue;
    const currency = symbol === '£' ? 'GBP' : symbol === '€' ? 'EUR' : 'USD';
    if (!best || value > best.value) best = { value, currency };
  }
  return best;
}

/**
 * The company the story is about.
 *
 * Google News titles end with " - Publication", and the publication is not the
 * lead — stripping it is the single most important step. What remains usually
 * opens with the actor ("GRAHAM awarded contract for…", "Bouygues Construction
 * wins…"), so the words before the event verb are the best available guess.
 *
 * Deliberately conservative: returns null rather than a phrase it is unsure of,
 * because a wrong company name is worse than a blank one — enrichment will
 * research whatever it is given, and a bad name sends it looking for a company
 * that does not exist.
 */
export function extractCompany(title: string): string | null {
  const headline = title.replace(/\s+-\s+[^-]+$/, '').trim();
  const event = headline.match(PROJECT_EVENT);
  if (!event || event.index === undefined) return null;

  let head = headline.slice(0, event.index).trim();
  // Drop a leading value or throat-clearing: "$200k contract awarded for…".
  head = head.replace(/^[£$€][\d.,]+\s*(bn|billion|m|million|k)?\s*/i, '').trim();
  head = head.replace(/^(the|a|an|new|uk|us)\s+/i, '').trim();
  if (head.length < 3 || head.length > 60) return null;
  /*
    A generic noun is not a company.

    "Contractor appointed by Knight Property Group…" yields "Contractor", which
    is worse than nothing: enrichment would go and research the word. Observed
    live, alongside "Council" and "Developer".
  */
  if (/^(contractor|council|developer|builder|firm|company|client|group|team|construction)$/i.test(head)) return null;
  /*
    The generic phrase, not just the generic word.

    "Head contractor appointed for The Avenue, Coburg" and "Main works contractor
    appointed for Bathurst Hospital" both name the ROLE and withhold the company —
    a very common Australian headline form. Left in, enrichment would go and
    research "Main works contractor".
  */
  if (/^(head|main|principal|managing|lead|preferred|successful)\s+(works\s+)?(contractor|builder|consultant)$/i.test(head)) return null;
  /*
    A company name is short. A sentence is not.

    Headlines that do not lead with the actor produce a clause instead of a name
    — "See where data center developers are looking", "North Tulsa's 36 North
    housing project". Both were observed live. Five words is generous for a
    company and ruthless for a sentence.
  */
  if (head.split(/\s+/).length > 5) return null;
  // A clause gives itself away with a verb or a possessive.
  if (/\b(are|is|was|were|has|have|will|would|could|says?|see|how|why|what|where)\b|'s\s/i.test(head)) return null;
  // A fragment with no capitalised word is a sentence, not a name.
  if (!/[A-Z]/.test(head)) return null;
  /*
    Trailing connectives and articles mean the name ran into the rest of the
    sentence. Looped, because "… Construction a" needs two passes, and one
    dangling word is what turns a company name into a fragment.
  */
  for (let i = 0; i < 3; i += 1) {
    const trimmed = head.replace(/\s+(a|an|the|and|to|for|of|in|on|at|with|its|their)$/i, '').trim();
    if (trimmed === head) break;
    head = trimmed;
  }
  return head.length >= 3 ? head : null;
}

/** Region, from the text — never from the feed's locale. */
export function extractRegion(text: string): NewsRegion | null {
  if (ELSEWHERE.test(text)) return null;
  /*
    APAC first. "Newcastle" and "Victoria" exist in both Britain and Australia,
    and an ASX ticker or a state name is decisive where a bare city name is not.
  */
  if (APAC_HINT.test(text)) return 'apac';
  if (UK_HINT.test(text)) return 'uk';
  if (US_HINT.test(text)) return 'usa';
  return null;
}

const VERTICAL_HINTS: [RegExp, string][] = [
  [/\bdata ?cent(re|er)\b/i, 'data_center'],
  [/\b(semiconductor|chip fab|foundry)\b/i, 'semiconductor'],
  [/\b(gigafactory|battery plant|battery cell)\b/i, 'battery'],
  [/\bsolar\b/i, 'solar'],
  [/\bwind (farm|turbine)\b/i, 'wind'],
  [/\bnuclear\b/i, 'nuclear'],
  [/\b(hospital|health ?centre|health ?center|nhs)\b/i, 'construction'],
  [/\b(pharmaceutical|biotech|life science)\b/i, 'pharma'],
  [/\b(mine|mining)\b/i, 'mining'],
  [/\b(oil|gas|lng|refinery)\b/i, 'oil_gas'],
  [/\b(substation|power (plant|station)|grid)\b/i, 'power'],
];

/**
 * Everything the Source Hub can decide about a headline before it is ingested.
 *
 * Cheap and deterministic on purpose — no model call, no API spend. This runs
 * over every item in every feed, and its job is to throw away the ~90% that are
 * not leads so that anything more expensive only ever sees candidates.
 */
export function extractLead(title: string, description: string, hunt: IcpHunt): NewsExtraction {
  const text = `${title} ${description}`;

  for (const rx of NOT_A_PROJECT) {
    if (rx.test(text)) return no('not a project story');
  }
  if (!PROJECT_EVENT.test(text)) return no('no project event — nothing has happened yet');
  if (!PROJECT_NOUN.test(text)) return no('an event, but not about a building');

  const region = extractRegion(text);
  if (!region) return no('not placeable in the USA or the UK');

  const company = extractCompany(title);
  if (!company) return no('no company could be identified');

  const money = extractValue(text);
  const vertical = VERTICAL_HINTS.find(([rx]) => rx.test(text))?.[1] ?? hunt.vertical;

  /*
    Tier is upgraded only on evidence. A hunt for Tier 2 that turns up Balfour
    Beatty has found a Tier 1, and filing it as Tier 2 because of which query
    caught it would put a national contractor in a regional rep's queue.
  */
  const icpCode = TIER1_HINT.test(text) && hunt.icpCode === 'tier2_gc' ? 'tier1_gc' : hunt.icpCode;

  return {
    isLead: true,
    reason: `${hunt.label} · ${region.toUpperCase()}`,
    region,
    company,
    vertical,
    icpCode,
    value: money?.value ?? null,
    currency: money?.currency ?? null,
  };
}

function no(reason: string): NewsExtraction {
  return { isLead: false, reason, region: null, company: null, vertical: null, icpCode: null, value: null, currency: null };
}
