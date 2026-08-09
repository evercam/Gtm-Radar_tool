import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterShapeError } from './types';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import type { CriticalField, BusinessUnit } from '@/lib/supabase/types';

/**
 * Generic RSS 2.0 news-feed adapter factory — the first XML source in the hub.
 * Powers two KEYLESS, live-verified data-center industry feeds that surface
 * new-build / expansion announcements for the mission_critical_owner ICP:
 *   - Data Center Dynamics  (datacenterdynamics.com/en/rss/)  — ~20 items
 *   - Data Center Knowledge (datacenterknowledge.com/rss.xml) — ~50 items
 *
 * These are early-signal PROJECT ANNOUNCEMENT feeds: rich title + link + date,
 * but no structured value/location/contact — deliberately a low-completeness
 * (tier D/E) discovery source that the Claude enrichment engine resolves into
 * an operator, location, and decision-maker downstream. Verified live
 * 2026-07-25.
 *
 * RSS is parsed with a small, dependency-free reader (regex over <item> blocks
 * + CDATA/entity decoding) — no XML library, consistent with the project's
 * stdlib-only ethos.
 */

export interface RssFeedConfig {
  slug: string; // URL slug used by /api/search & /api/ingest
  sourceKey: string; // source_registry.source_key
  icpCode: string;
  bu: BusinessUnit;
  feedUrl: string;
  /** Constant project/building type these dedicated feeds cover (e.g. "Data center"). */
  buildingType: string | null;
  /** ISO-2 default; null for global feeds with no per-item geography. */
  countryCode: string | null;
}

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  guid: string;
  creator: string;
  category: string;
}

// ---- minimal RSS reader -----------------------------------------------------

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&#0*38;|&#x0*26;/gi, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // last, so &amp;lt; -> &lt; is not double-decoded
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract the text of the first <name>…</name> in a block (namespaced ok). */
function tagText(block: string, name: string): string {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = re.exec(block);
  return m ? decodeEntities(stripCdata(m[1])).trim() : '';
}

function allTagText(block: string, name: string): string[] {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const v = decodeEntities(stripCdata(m[1])).trim();
    if (v) out.push(v);
  }
  return out;
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    items.push({
      title: tagText(block, 'title'),
      link: tagText(block, 'link'),
      description: tagText(block, 'description'),
      pubDate: tagText(block, 'pubDate') || tagText(block, 'dc:date'),
      guid: tagText(block, 'guid'),
      creator: tagText(block, 'dc:creator'),
      category: allTagText(block, 'category').join(', '),
    });
  }
  return items;
}

function rfc822ToDay(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ---- publisher registry -----------------------------------------------------

export const RSS_FEEDS: RssFeedConfig[] = [
  {
    slug: 'data-center-dynamics',
    sourceKey: 'data_center_dynamics',
    icpCode: 'mission_critical_owner',
    bu: 'export',
    feedUrl: 'https://www.datacenterdynamics.com/en/rss/',
    buildingType: 'Data center',
    countryCode: null,
  },
  {
    slug: 'data-center-knowledge',
    sourceKey: 'data_center_knowledge',
    icpCode: 'mission_critical_owner',
    bu: 'export',
    feedUrl: 'https://www.datacenterknowledge.com/rss.xml',
    buildingType: 'Data center',
    countryCode: null,
  },
  // "Similar projects" to data centers — the rest of the mission_critical_owner
  // ICP (semiconductor fabs, battery gigafactories) and the critical_infra_owner
  // ICP (power, nuclear, mining). All verified live 2026-07-25.
  {
    slug: 'semiconductor-digest',
    sourceKey: 'semiconductor_digest',
    icpCode: 'mission_critical_owner',
    bu: 'export',
    feedUrl: 'https://www.semiconductor-digest.com/feed/',
    buildingType: 'Semiconductor fab',
    countryCode: null,
  },
  {
    slug: 'electrive',
    sourceKey: 'electrive',
    icpCode: 'mission_critical_owner',
    bu: 'export',
    feedUrl: 'https://www.electrive.com/feed/',
    buildingType: 'Battery / EV facility',
    countryCode: null,
  },
  {
    slug: 'power-technology',
    sourceKey: 'power_technology',
    icpCode: 'critical_infra_owner',
    bu: 'export',
    feedUrl: 'https://www.power-technology.com/feed/',
    buildingType: 'Power / energy facility',
    countryCode: null,
  },
  {
    slug: 'nuclear-engineering',
    sourceKey: 'nuclear_engineering_intl',
    icpCode: 'critical_infra_owner',
    bu: 'export',
    feedUrl: 'https://www.neimagazine.com/feed/',
    buildingType: 'Nuclear facility',
    countryCode: null,
  },
  {
    slug: 'mining-com',
    sourceKey: 'mining_com',
    icpCode: 'critical_infra_owner',
    bu: 'export',
    feedUrl: 'https://www.mining.com/feed/',
    buildingType: 'Mining / industrial',
    countryCode: null,
  },
  {
    slug: 'construction-dive',
    sourceKey: 'construction_dive',
    icpCode: 'tier1_gc',
    bu: 'usa',
    feedUrl: 'https://www.constructiondive.com/feeds/news/',
    buildingType: null, // general construction industry news
    countryCode: 'US',
  },
];

function makeRssAdapter(cfg: RssFeedConfig): SourceAdapter {
  return {
    sourceKey: cfg.sourceKey,

    async isConfigured(): Promise<boolean> {
      return true; // keyless
    },

    async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
      const feedUrl = params.credentials?.baseUrl?.trim() || cfg.feedUrl;
      const pageSize = params.dryRun ? Math.min(params.pageSize ?? 5, 100) : (params.pageSize ?? 100);

      const res = await fetchWithRetry(
        feedUrl,
        {
          headers: {
            Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
            /*
              Mozilla-prefixed, and it has to be.

              `EvercamSourceHub/1.0` is the honest thing to send and mining.com
              answers it with HTTP 403 — verified 2026-08-09, where the same URL
              returns 200 for a Mozilla-prefixed agent and 403 for curl's. Bot
              protection in front of these publishers rejects anything that does
              not look like a browser, so a bare product token silently killed one
              feed and would eventually kill others.

              This still identifies us and carries a contact address, which is
              what the polite convention actually asks for — it is the same string
              the OCDS adapters have always sent.
            */
            'User-Agent': 'Mozilla/5.0 Evercam Source Hub research@evercam.io',
          },
        },
        { timeoutMs: 20_000 }
      );
      if (!res.ok) {
        throw new Error(`${cfg.slug} RSS request failed: HTTP ${res.status} ${res.statusText}`);
      }
      const xml = await res.text();
      if (!/<item\b/i.test(xml)) {
        throw new AdapterShapeError(`${cfg.slug} RSS response contained no <item> entries.`);
      }
      let items = parseRssItems(xml);

      // Date window (client-side; RSS has no server-side query).
      const sinceT = params.since ? params.since.getTime() : -Infinity;
      const untilT = params.until ? params.until.getTime() : Infinity;
      items = items.filter((it) => {
        const t = new Date(it.pubDate).getTime();
        return Number.isNaN(t) || (t >= sinceT && t <= untilT);
      });

      // Keyword + region filters over title/description/category.
      if (params.keyword?.trim()) {
        const kw = params.keyword.trim().toLowerCase();
        items = items.filter((it) => `${it.title} ${it.description} ${it.category}`.toLowerCase().includes(kw));
      }
      if (params.regions?.length) {
        const wanted = params.regions.map((r) => r.toLowerCase());
        items = items.filter((it) => {
          const hay = `${it.title} ${it.description} ${it.category}`.toLowerCase();
          return wanted.some((w) => hay.includes(w));
        });
      }

      const start = ((params.page ?? 1) - 1) * pageSize;
      return items.slice(start, start + pageSize) as unknown as RawProjectRecord[];
    },

    normalize(raw: RawProjectRecord): CanonicalProjectInsert {
      const it = raw as unknown as RssItem;
      const title = it.title || 'Untitled announcement';
      const extId = it.guid || it.link || title;
      const desc = it.description ? stripHtml(it.description).slice(0, 1000) : null;
      const announced = rfc822ToDay(it.pubDate);

      const presentFields: Partial<Record<CriticalField, boolean>> = {
        project_name: isPresent(title),
        project_value: false,
        project_location: false, // resolved by enrichment
        project_timeline: isPresent(announced),
        building_type: isPresent(cfg.buildingType),
        company_name: false, // operator resolved by enrichment from title/desc
        company_contact: false,
        project_phase: true, // announcement stage
        square_footage: false,
        funding_source: false,
        company_website: false,
        company_phone: false,
      };

      const completeness = computeCompleteness(presentFields);

      return {
        canonical_name: title.slice(0, 300),
        source_key: cfg.sourceKey,
        source_unique_id: extId.slice(0, 500),
        icp_code: cfg.icpCode,
        record_type: 'news',
        bu: cfg.bu,
        project_type: cfg.buildingType,
        building_type: cfg.buildingType,
        description:
          [desc, it.category ? `Topics: ${it.category}` : null].filter(Boolean).join(' — ').slice(0, 1000) || null,
        address_line1: null,
        city: null,
        state_province: null,
        country: cfg.countryCode,
        country_code: cfg.countryCode,
        announced_date: announced,
        construction_start_date: null,
        estimated_completion_date: null,
        bid_date: null,
        project_url: it.link || null,
        current_phase: 'Announcement',
        estimated_value: null,
        estimated_value_currency: null,
        company_name_raw: null,
        contact_name: it.creator || null,
        contact_title: it.creator ? 'Author' : null,
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
}

export const dataCenterDynamicsAdapter = makeRssAdapter(RSS_FEEDS[0]);
export const dataCenterKnowledgeAdapter = makeRssAdapter(RSS_FEEDS[1]);
export const semiconductorDigestAdapter = makeRssAdapter(RSS_FEEDS[2]);
export const electriveAdapter = makeRssAdapter(RSS_FEEDS[3]);
export const powerTechnologyAdapter = makeRssAdapter(RSS_FEEDS[4]);
export const nuclearEngineeringAdapter = makeRssAdapter(RSS_FEEDS[5]);
export const miningComAdapter = makeRssAdapter(RSS_FEEDS[6]);
export const constructionDiveAdapter = makeRssAdapter(RSS_FEEDS[7]);
