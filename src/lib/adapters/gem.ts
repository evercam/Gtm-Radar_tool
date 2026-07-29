import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { readGemFiles } from '@/lib/gem/local';
import {
  GEM_SOURCE_KEY,
  gemBuForRow,
  gemCapacity,
  normalizeGemRecord,
  parseGemFile,
  trackerFromFilename,
} from '@/lib/gem/normalize';

/**
 * GEM search adapter — makes the uploaded Global Energy Monitor trackers
 * searchable through the standard /api/search/[source] flow, reading from the
 * local GEM folder (GEM_DATA_DIR, default ./data/gem) rather than a remote API.
 *
 * Parameter mapping (the search UI sends the shared param set):
 *   - `sectors`  -> GEM trackers to include (e.g. ["solar","nuclear"]); empty = all
 *   - `regions`  -> country / region / state substring match
 *   - `keyword`  -> free-text match across the raw record
 *   - `minValue` -> minimum capacity (MW for power, ttpa for mines)
 *   - `phases`   -> operating status, applied by the search route after normalize
 *
 * Each returned raw row is tagged with `__gem_tracker` so normalize() can route
 * it to the right label/ICP without re-deriving the tracker.
 */

// Bound on rows scanned per request so a fully-excluding filter can't walk
// every row of every large tracker (solar alone is ~8,700 rows).
const MAX_SCAN = 60_000;

export const gemAdapter: SourceAdapter = {
  sourceKey: GEM_SOURCE_KEY,

  async isConfigured(): Promise<boolean> {
    return true; // reads local files; an empty folder simply yields no results
  },

  async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
    const pageSize = params.dryRun ? Math.min(params.pageSize ?? 5, 50) : (params.pageSize ?? 50);

    const trackers = params.sectors?.length ? params.sectors.map((s) => trackerFromFilename(s)) : undefined;
    const requested = trackers?.map((t) => `${t}.json`);
    const { inputs } = await readGemFiles(requested);

    const kw = params.keyword?.trim().toLowerCase();
    const regions = params.regions?.length ? params.regions.map((r) => r.toLowerCase()) : undefined;
    const minCap = typeof params.minValue === 'number' ? params.minValue : undefined;
    const bus = params.businessUnits?.length ? new Set(params.businessUnits.map((b) => b.toLowerCase())) : undefined;

    const out: RawProjectRecord[] = [];
    let scanned = 0;

    for (const file of inputs) {
      const tracker = trackerFromFilename(file.name);
      let rows: RawProjectRecord[];
      try {
        rows = parseGemFile(file.text);
      } catch {
        continue; // skip an unparseable file rather than fail the whole search
      }

      for (const row of rows) {
        if (out.length >= pageSize || scanned >= MAX_SCAN) break;
        scanned += 1;
        const r = row as Record<string, unknown>;

        if (kw && !JSON.stringify(r).toLowerCase().includes(kw)) continue;

        if (regions) {
          const hay = [
            r['Country/Area'],
            r['Country/area'],
            r['CountriesOrAreas'],
            r['Countries'],
            r['StartCountryOrArea'],
            r['EndCountryOrArea'],
            r['Region'],
            r['Subregion'],
            r['State/Province'],
            r['Subnational unit'],
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!regions.some((w) => hay.includes(w))) continue;
        }

        if (minCap !== undefined) {
          const cap = gemCapacity(r);
          if (cap === null || cap < minCap) continue;
        }

        if (bus && !bus.has(gemBuForRow(row))) continue;

        r.__gem_tracker = tracker;
        out.push(row);
      }
      if (out.length >= pageSize || scanned >= MAX_SCAN) break;
    }

    return out;
  },

  normalize(raw: RawProjectRecord): CanonicalProjectInsert {
    const tracker = String((raw as Record<string, unknown>).__gem_tracker ?? 'gem');
    return normalizeGemRecord(raw, tracker);
  },
};
