import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import { ICP_HUNTS, newsFeedUrl, extractLead, type IcpHunt, type NewsRegion } from '@/lib/news/icp';
import type { CriticalField, BusinessUnit } from '@/lib/supabase/types';

/**
 * Construction news, hunted per ICP across the USA and the UK.
 *
 * Every other source reads a register — a permit file, a tender portal, an asset
 * tracker — and gets a record. This one reads the trade press and gets prose, so
 * it is the earliest signal available and the noisiest.
 *
 * It loops: for each ICP, for each region, for each query. That structure is the
 * point. A single "construction news" sweep finds the same handful of national
 * contractors every time, because they are what gets written about; asking
 * separately for a data-centre owner, a Tier 2 subcontractor and a housing
 * developer finds three different sets of companies.
 *
 * The qualification happens HERE, before ingestion, in `@/lib/news/icp`. Roughly
 * nine in ten items in these feeds are not leads — they are results
 * announcements, awards ceremonies, executive hires and market commentary that
 * use exactly the vocabulary of a contract award. Writing them all into
 * canonical_projects and sorting it out downstream would bury the reps, so an
 * item becomes a record only if a project event, a building, a named company and
 * a country we sell in can all be established from the text.
 *
 * Keyless: Google News search RSS, which needs no account.
 */

interface NewsItem {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
  source: string | null;
}

/** RSS is XML, and these feeds wrap almost everything in CDATA. */
function textOf(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseItems(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const title = textOf(block, 'title');
    if (!title) continue;
    out.push({
      title,
      link: textOf(block, 'link'),
      description: textOf(block, 'description'),
      pubDate: textOf(block, 'pubDate') || null,
      source: textOf(block, 'source') || null,
    });
  }
  return out;
}

/** What one qualified item carries into normalize(). */
interface NewsLead extends Record<string, unknown> {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
  publisher: string | null;
  company: string;
  region: NewsRegion;
  vertical: string;
  icpCode: string;
  value: number | null;
  currency: string | null;
  hunt: string;
  query: string;
}

const BU_BY_REGION: Record<NewsRegion, BusinessUnit> = { usa: 'usa', uk: 'uk', apac: 'apac' };
const COUNTRY_BY_REGION: Record<NewsRegion, { name: string; code: string }> = {
  usa: { name: 'United States', code: 'US' },
  uk: { name: 'United Kingdom', code: 'GB' },
  /*
    AU rather than NZ, because the hint set covers both and Australia is the bulk
    of it. A New Zealand project therefore lands as apac with an AU country code —
    the business unit is right, the country is approximate, and that is better
    than dropping the lead.
  */
  apac: { name: 'Australia', code: 'AU' },
};

/**
 * Between feed requests.
 *
 * The loop is ICP × region × query — five ICPs is seventeen queries and
 * thirty-four requests — and hammering a public endpoint that fast is both rude
 * and the quickest way to be blocked. Two seconds keeps a full sweep near a
 * minute, which is well inside the route's ceiling.
 */
const REQUEST_GAP_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const newsSearchAdapter: SourceAdapter = {
  sourceKey: 'news_search',

  async isConfigured(): Promise<boolean> {
    return true; // keyless
  },

  async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
    const maxRecords = params.dryRun ? Math.min(params.pageSize ?? 10, 50) : (params.maxRecords ?? params.pageSize ?? 200);

    /*
      Which ICPs to hunt. `verticals` doubles as the ICP filter here rather than
      a new parameter: the saved-query UI already offers it, and an operator
      asking for "just the data-centre owners" is expressing the same intent.
    */
    const wanted = params.verticals?.length
      ? ICP_HUNTS.filter((h) => params.verticals!.some((v) => h.icpCode === v || h.vertical === v))
      : ICP_HUNTS;
    const hunts = wanted.length > 0 ? wanted : ICP_HUNTS;

    const regions: NewsRegion[] = params.regions?.length
      ? (params.regions
          .map((r) => r.toLowerCase())
          .filter((r): r is NewsRegion => r === 'usa' || r === 'uk' || r === 'apac') as NewsRegion[])
      : ['usa', 'uk', 'apac'];
    const useRegions = regions.length > 0 ? regions : (['usa', 'uk', 'apac'] as NewsRegion[]);

    const leads: NewsLead[] = [];
    const seen = new Set<string>();
    let requests = 0;

    /*
      Round-robin across the ICPs, not one ICP at a time.

      Depth-first looked right and was wrong: a run capped at 40 records spent
      its whole budget inside the first hunt and returned 40 Tier 1 contractors
      and nothing else — verified live. The point of hunting per ICP is coverage
      ACROSS them, so the queries are interleaved and every ICP gets a turn
      before any ICP gets a second one.
    */
    const rounds: { hunt: IcpHunt; region: NewsRegion; query: string }[] = [];
    const deepest = Math.max(...hunts.map((h) => h.queries.length));
    for (let i = 0; i < deepest; i += 1) {
      for (const hunt of hunts) {
        const query = hunt.queries[i];
        if (!query) continue;
        for (const region of useRegions) rounds.push({ hunt, region, query });
      }
    }

    outer: {
      for (const { hunt, region, query } of rounds) {
        {
          if (leads.length >= maxRecords) break outer;
          if (requests > 0) await sleep(REQUEST_GAP_MS);
          requests += 1;

          const url = newsFeedUrl(query, region);
          let xml: string;
          try {
            const res = await fetchWithRetry(
              url,
              {
                headers: {
                  Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
                  // Bot protection in front of news sites rejects bare product
                  // tokens; this identifies us and carries a contact address.
                  'User-Agent': 'Mozilla/5.0 Evercam Source Hub research@evercam.io',
                },
              },
              { timeoutMs: 20_000 }
            );
            if (!res.ok) continue; // one dead query must not fail the whole sweep
            xml = await res.text();
          } catch {
            continue;
          }

          if (!/<item\b/i.test(xml)) {
            // The very first request returning nothing item-shaped means the feed
            // format changed; later ones are just an empty query.
            if (requests === 1) throw new AdapterShapeError('news-search: the feed contained no <item> entries.');
            continue;
          }

          for (const item of parseItems(xml)) {
            if (leads.length >= maxRecords) break outer;
            const verdict = extractLead(item.title, item.description, hunt);
            if (!verdict.isLead || !verdict.region || !verdict.company) continue;
            /*
              The region comes from the TEXT, not from the locale we asked — and a
              locale is only a ranking hint, so an AU feed returns UK stories.
              Asking for APAC and getting Bouygues in Overdale is not wrong data,
              but it is not what was requested, so the result is filtered to the
              regions the caller named.
            */
            if (!useRegions.includes(verdict.region)) continue;

            /*
              The same story is syndicated across outlets and surfaces under
              several queries. Keyed on company + the headline's own words rather
              than the URL, because the URL differs per outlet for one story.
            */
            const key = `${verdict.company.toLowerCase()}|${item.title.replace(/\s+-\s+[^-]+$/, '').toLowerCase().slice(0, 70)}`;
            if (seen.has(key)) continue;
            seen.add(key);

            leads.push({
              title: item.title.replace(/\s+-\s+[^-]+$/, '').trim(),
              link: item.link,
              description: item.description,
              pubDate: item.pubDate,
              publisher: item.source,
              company: verdict.company,
              region: verdict.region,
              vertical: verdict.vertical ?? hunt.vertical,
              icpCode: verdict.icpCode ?? hunt.icpCode,
              value: verdict.value,
              currency: verdict.currency,
              hunt: hunt.label,
              query,
            });
          }
        }
      }
    }

    return leads as unknown as RawProjectRecord[];
  },

  normalize(raw: RawProjectRecord): CanonicalProjectInsert {
    const r = raw as unknown as NewsLead;
    const country = COUNTRY_BY_REGION[r.region];

    /*
      The identity is the story, not the URL.

      A syndicated article has a different link per outlet, so keying on the link
      would ingest the same award four times. Company plus headline is stable
      across outlets and is what makes a re-run update rather than duplicate.
    */
    const externalId = `${r.company}|${r.title}`.toLowerCase().replace(/\s+/g, ' ').slice(0, 180);

    const presentFields: Partial<Record<CriticalField, boolean>> = {
      project_name: isPresent(r.title),
      project_value: r.value != null,
      project_location: true, // region is established before a lead is created
      project_timeline: isPresent(r.pubDate),
      building_type: isPresent(r.vertical),
      company_name: isPresent(r.company),
      company_contact: false,
      project_phase: true, // a news lead is always an announcement
      square_footage: false,
      funding_source: false,
      company_website: false,
      company_phone: false,
    };
    const completeness = computeCompleteness(presentFields);

    return {
      canonical_name: r.title.slice(0, 300),
      source_key: 'news_search',
      source_unique_id: externalId,
      icp_code: r.icpCode,
      record_type: 'news',
      bu: BU_BY_REGION[r.region],
      project_type: r.vertical,
      building_type: null,
      description: [r.description, r.publisher ? `Reported by ${r.publisher}.` : null, `Found hunting: ${r.hunt}.`]
        .filter(Boolean)
        .join(' ')
        .slice(0, 1000),
      city: null,
      state_province: null,
      country: country.name,
      country_code: country.code,
      announced_date: normalizeDate(r.pubDate),
      construction_start_date: null,
      estimated_completion_date: null,
      bid_date: null,
      project_url: r.link || null,
      current_phase: 'Announcement',
      estimated_value: r.value,
      estimated_value_currency: r.currency,
      company_name_raw: r.company,
      contact_name: null,
      contact_title: null,
      contact_email: null,
      contact_phone: null,
      source_completeness_tier: completeness.tier,
      source_completeness_score: completeness.score,
      fields_populated: completeness.fieldsPopulated,
      fields_missing: completeness.fieldsMissing,
      population_percentage: completeness.populationPercentage,
      processing_status: 'normalized',
      raw_data: raw,
    };
  },
};

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export { ICP_HUNTS };
export type { IcpHunt };
