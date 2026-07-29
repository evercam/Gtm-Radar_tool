import { computeCompleteness, isPresent } from '@/lib/completeness';
import type { CanonicalProjectInsert, RawProjectRecord } from '@/lib/adapters/types';
import type { CriticalField, BusinessUnit } from '@/lib/supabase/types';

/**
 * Global Energy Monitor (GEM) file normalizer — powers the drag-and-drop
 * upload tool (/ingest/gem). GEM publishes worldwide asset-level trackers as
 * JSON arrays (energy, extraction, heavy industry): solar, wind, nuclear,
 * hydro, coal, oil & gas, LNG, pipelines, mines, steel, cement, chemicals…
 *
 * These are NOT fetched from an API (GEM data is downloaded and uploaded by
 * the user), so this lives outside lib/adapters — but it produces the same
 * CanonicalProjectInsert shape and reuses the shared completeness scorer, so
 * uploaded records land in canonical_projects identically to adapter records.
 *
 * Column names differ per tracker, so every field probes a list of candidate
 * keys (like the OCDS adapter probes several release locations). The account =
 * the Owner / Operator / Parent company; personal contacts are resolved later
 * by the Claude + Apollo enrichment engine.
 */

export const GEM_SOURCE_KEY = 'gem_energy_tracker';

export interface GemTrackerConfig {
  /** Human building/project type. */
  label: string;
  /** ICP a record from this tracker is routed to. */
  icp: string;
  /**
   * Legacy default BU. The actual BU is derived per-record from the asset's
   * geography — GEM is worldwide — via resolveGemBu(); this field is only a
   * fallback shape and is not what lands on the record.
   */
  bu: BusinessUnit;
}

/** Fallback for any tracker not in the map below. */
export const DEFAULT_GEM_CONFIG: Omit<GemTrackerConfig, 'label'> = {
  icp: 'critical_infra_owner',
  bu: 'export',
};

/**
 * Per-tracker routing. Every GEM tracker is energy / extraction / heavy
 * industry, all of which fall under the Critical Infrastructure Owner ICP
 * (target sectors: energy, oil & gas, mining, industrial). This map is the
 * single override point — change one line to send a tracker to a different ICP
 * or BU (e.g. route a future battery tracker to mission_critical_owner).
 */
export const GEM_TRACKER_CONFIG: Record<string, GemTrackerConfig> = {
  bio: { label: 'Bioenergy plant', icp: 'critical_infra_owner', bu: 'export' },
  cement: { label: 'Cement plant', icp: 'critical_infra_owner', bu: 'export' },
  chemicals: { label: 'Chemical plant', icp: 'critical_infra_owner', bu: 'export' },
  coal_mine: { label: 'Coal mine', icp: 'critical_infra_owner', bu: 'export' },
  coal_plant: { label: 'Coal power plant', icp: 'critical_infra_owner', bu: 'export' },
  coal_terminal: { label: 'Coal terminal', icp: 'critical_infra_owner', bu: 'export' },
  gas_pipeline: { label: 'Gas pipeline', icp: 'critical_infra_owner', bu: 'export' },
  geo: { label: 'Geothermal power plant', icp: 'critical_infra_owner', bu: 'export' },
  hydro: { label: 'Hydroelectric plant', icp: 'critical_infra_owner', bu: 'export' },
  iron_ore_mine: { label: 'Iron ore mine', icp: 'critical_infra_owner', bu: 'export' },
  lng: { label: 'LNG terminal', icp: 'critical_infra_owner', bu: 'export' },
  nuclear: { label: 'Nuclear power plant', icp: 'critical_infra_owner', bu: 'export' },
  oil_gas_extraction: { label: 'Oil & gas extraction', icp: 'critical_infra_owner', bu: 'export' },
  oil_gas_plant: { label: 'Oil & gas power plant', icp: 'critical_infra_owner', bu: 'export' },
  oil_ngl_pipeline: { label: 'Oil / NGL pipeline', icp: 'critical_infra_owner', bu: 'export' },
  solar: { label: 'Solar farm', icp: 'critical_infra_owner', bu: 'export' },
  steel: { label: 'Steel plant', icp: 'critical_infra_owner', bu: 'export' },
  wind: { label: 'Wind farm', icp: 'critical_infra_owner', bu: 'export' },
};

/** Normalize an uploaded filename to a tracker slug ("Solar.JSON" -> "solar"). */
export function trackerFromFilename(filename: string): string {
  const base = filename
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .trim();
  return base.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Resolve routing for a tracker, falling back to the default ICP/BU. */
export function gemConfig(tracker: string): GemTrackerConfig {
  return (
    GEM_TRACKER_CONFIG[tracker] ?? {
      label: tracker.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      ...DEFAULT_GEM_CONFIG,
    }
  );
}

export function trackerLabel(tracker: string): string {
  return gemConfig(tracker).label;
}

// ---- geography -> business unit --------------------------------------------
// GEM is worldwide, so a record's BU follows its location, not the tracker.
// The dedicated regional BUs are usa / uk / ireland / apac; everything else
// (rest of Europe, Middle East, Africa, Latin America, Canada, Eurasia) is the
// Export / Major Projects BU.

const APAC_COUNTRIES = new Set([
  'china',
  'india',
  'japan',
  'south korea',
  'korea, south',
  'republic of korea',
  'korea',
  'australia',
  'new zealand',
  'indonesia',
  'vietnam',
  'viet nam',
  'philippines',
  'thailand',
  'malaysia',
  'singapore',
  'taiwan',
  'bangladesh',
  'pakistan',
  'myanmar',
  'burma',
  'cambodia',
  'laos',
  'sri lanka',
  'nepal',
  'mongolia',
  'hong kong',
  'macau',
  'papua new guinea',
  'fiji',
  'brunei',
  'bhutan',
  'maldives',
  'timor-leste',
  'east timor',
  'north korea',
  'korea, north',
]);

/** GEM "Region" values that imply Asia-Pacific when the country is ambiguous. */
const APAC_REGION_RE = /east asia|south asia|se asia|southeast asia|south-?east asia|pacific|oceania|australasia/i;

export function resolveGemBu(country: string | null, region: string | null): BusinessUnit {
  const c = (country ?? '').trim().toLowerCase();
  if (/united states|u\.?s\.?a\.?|\bus\b|america(?!n samoa)/.test(c)) return 'usa';
  // Northern Ireland is part of the UK; the Republic of Ireland is its own BU.
  if (/northern ireland/.test(c)) return 'uk';
  if (/united kingdom|great britain|\bu\.?k\.?\b|england|scotland|wales/.test(c)) return 'uk';
  if (/\bireland\b|\beire\b/.test(c)) return 'ireland';
  if (APAC_COUNTRIES.has(c) || APAC_REGION_RE.test(region ?? '')) return 'apac';
  return 'export';
}

// ---- parsing ----------------------------------------------------------------

/**
 * Parse a GEM file's text into an array of raw row objects. Accepts a plain
 * JSON array (the usual GEM shape), a wrapped object ({data|records|rows|...}),
 * or a GeoJSON FeatureCollection (properties are flattened, geometry coords
 * copied to Latitude/Longitude).
 */
export function parseGemFile(text: string): RawProjectRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  let rows: unknown;
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    rows = obj.data ?? obj.records ?? obj.rows ?? obj.results ?? obj.features ?? firstArrayValue(obj);
  }

  if (!Array.isArray(rows)) {
    throw new Error('Expected a JSON array of records (or a wrapper object containing one).');
  }

  return rows.map((r) => flattenFeature(r)).filter((r): r is RawProjectRecord => r !== null);
}

function firstArrayValue(obj: Record<string, unknown>): unknown {
  for (const v of Object.values(obj)) if (Array.isArray(v)) return v;
  return undefined;
}

/** A GeoJSON Feature -> flat row; a plain object -> itself. */
function flattenFeature(row: unknown): RawProjectRecord | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (r.type === 'Feature' && r.properties && typeof r.properties === 'object') {
    const props = { ...(r.properties as Record<string, unknown>) };
    const geom = r.geometry as { coordinates?: unknown } | undefined;
    const coords = geom?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2 && typeof coords[0] === 'number') {
      props.Longitude = props.Longitude ?? coords[0];
      props.Latitude = props.Latitude ?? coords[1];
    }
    return props;
  }
  return r;
}

// ---- field probing ----------------------------------------------------------

function firstPresent(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v !== null && v !== undefined && String(v).trim() !== '' && String(v).toLowerCase() !== 'unknown') {
      return String(v).trim();
    }
  }
  return null;
}

function numOrNull(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

const NAME_KEYS = [
  'Project Name',
  'Asset name (English)',
  'GEM Asset name (English)',
  'Plant name (English)',
  'Plant Name',
  'PipelineName',
  'Pipeline Name',
  'TerminalName',
  'Terminal Name',
  'Coal Terminal Name',
  'Mine Name',
  'Complex Name',
  'Unit Name',
  'UnitName',
];
const UNIT_KEYS = ['Unit Name', 'UnitName', 'Phase Name', 'SegmentName'];
const OWNER_KEYS = [
  'Owner',
  'Owners',
  'Owner(s)',
  'Owner (English)',
  'Owner name (English)',
  'Operator',
  'Parent',
  'Parent Company',
  'Parent(s)',
];
const OPERATOR_KEYS = ['Operator', 'VesselOperator', 'Owner', 'Owners', 'Parent'];
const ID_KEYS = [
  'GEM location ID',
  'GEM unit ID',
  'GEM phase ID',
  'GEM Asset ID',
  'GEM Mine ID',
  'GEM plant ID',
  'GEM Plant ID',
  'GEM Terminal ID',
  'GEM Unit/Phase ID',
  'GEM Entity ID',
  'Unit ID',
  'UnitID',
  'ProjectID',
  'Project ID',
  'Government unit ID',
  'MSHA ID',
  'Other IDs (unit/phase)',
  'Other IDs (location)',
  'Source ID',
];
const COUNTRY_KEYS = ['Country/Area', 'Country/area', 'Country', 'Countries'];
const STATE_KEYS = [
  'State/Province',
  'Subnational unit',
  'Major Area (prefecture, district)',
  'Major area (prefecture, district)',
];
const CITY_KEYS = ['City', 'Municipality', 'Local Area (taluk, county)', 'Local area (taluk, county)'];
const REGION_KEYS = ['Region', 'Subregion'];
const STATUS_KEYS = ['Status', 'Operating status'];
const CAPACITY_KEYS = [
  'Capacity (MW)',
  'Capacity',
  'Reference Net Capacity (MW)',
  'Design Net Capacity (MW)',
  'Design capacity (ttpa)',
];
const TYPE_DETAIL_KEYS = ['Reactor Type', 'Technology Type', 'Model', 'Fuel', 'Capacity Rating'];
const URL_KEYS = ['Wiki URL', 'GEM wiki page URL', 'Url', 'URL'];
const CONSTRUCTION_KEYS = ['Construction Start Date', 'Start date'];
const START_KEYS = ['Construction Start Date', 'Start date', 'Start Year', 'Start year'];
const COMPLETION_KEYS = ['Commercial Operation Date', 'First Grid Connection', 'Start Year', 'Start year'];

function parseLatLng(row: Record<string, unknown>): { lat: number | null; lng: number | null } {
  const lat = numOrNull(firstPresent(row, ['Latitude', 'latitude', 'lat']));
  const lng = numOrNull(firstPresent(row, ['Longitude', 'longitude', 'lon', 'lng']));
  if (lat !== null && lng !== null) return { lat, lng };
  const combined = firstPresent(row, ['Coordinates', 'coordinates', 'Location']);
  if (combined) {
    const parts = combined.split(',').map((p) => Number(p.trim()));
    if (parts.length >= 2 && !parts.some(Number.isNaN)) return { lat: parts[0], lng: parts[1] };
  }
  return { lat, lng };
}

/** Full date (YYYY-MM-DD / YYYY/MM/DD), or a bare year -> YYYY-01-01. */
function toDate(value: string | null): string | null {
  if (!value) return null;
  const iso = value.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const year = value.match(/^(\d{4})$/) || value.match(/\b(19|20)\d{2}\b/);
  if (year) return `${year[0].slice(0, 4)}-01-01`;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Best-effort capacity in the tracker's native unit (MW for power, ttpa for
 *  mines) — used by the GEM search adapter's min-capacity filter. */
export function gemCapacity(raw: RawProjectRecord): number | null {
  return numOrNull(firstPresent(raw as Record<string, unknown>, CAPACITY_KEYS));
}

/** Resolve a raw row's business unit from its geography — used by the GEM
 *  search adapter's BU filter (matches how normalize() assigns `bu`). */
export function gemBuForRow(raw: RawProjectRecord): BusinessUnit {
  const row = raw as Record<string, unknown>;
  return resolveGemBu(firstPresent(row, COUNTRY_KEYS), firstPresent(row, REGION_KEYS));
}

// ---- normalize --------------------------------------------------------------

export function normalizeGemRecord(raw: RawProjectRecord, tracker: string): CanonicalProjectInsert {
  const row = raw as Record<string, unknown>;
  const cfg = gemConfig(tracker);
  const label = cfg.label;

  const projectName = firstPresent(row, NAME_KEYS);
  const unit = firstPresent(row, UNIT_KEYS);
  const name = projectName
    ? unit && unit !== projectName
      ? `${projectName} — ${unit}`
      : projectName
    : `GEM ${label} asset`;

  const gemId = firstPresent(row, ID_KEYS);
  const country = firstPresent(row, COUNTRY_KEYS);
  const state = firstPresent(row, STATE_KEYS);
  const city = firstPresent(row, CITY_KEYS);
  const region = firstPresent(row, REGION_KEYS);
  const owner = firstPresent(row, OWNER_KEYS);
  const operator = firstPresent(row, OPERATOR_KEYS);
  const status = firstPresent(row, STATUS_KEYS);
  const capacity = firstPresent(row, CAPACITY_KEYS);
  const typeDetail = firstPresent(row, TYPE_DETAIL_KEYS);
  const url = firstPresent(row, URL_KEYS);
  const { lat, lng } = parseLatLng(row);

  const startVal = firstPresent(row, START_KEYS);
  const announced = toDate(startVal);
  const constructionStart = toDate(firstPresent(row, CONSTRUCTION_KEYS));
  const completion = toDate(firstPresent(row, COMPLETION_KEYS));

  // Stable, source-unique id. Prefix with tracker so ids never collide across
  // trackers; fall back to a deterministic name|country key when GEM omits one.
  const uniqueId = `${tracker}:${gemId ?? `${slug(name)}|${slug(country ?? '')}`}`;

  const buildingType = typeDetail ? `${label} (${typeDetail})` : label;
  const company = owner ?? operator;

  const presentFields: Partial<Record<CriticalField, boolean>> = {
    project_name: isPresent(name),
    project_value: false, // GEM publishes capacity (MW/tonnes), not monetary value
    project_location: isPresent(country) || isPresent(state) || (lat !== null && lng !== null),
    project_timeline: isPresent(announced) || isPresent(constructionStart),
    building_type: true,
    company_name: isPresent(company),
    company_contact: false, // resolved by enrichment
    project_phase: isPresent(status),
    square_footage: false,
    funding_source: false,
    company_website: false,
    company_phone: false,
  };

  const completeness = computeCompleteness(presentFields);

  const descriptionParts = [
    capacity ? `Capacity: ${capacity} ${capacityUnit(row)}`.trim() : null,
    typeDetail ? `Type: ${typeDetail}` : null,
    operator && operator !== owner ? `Operator: ${operator}` : null,
    region ? `Region: ${region}` : null,
  ].filter(Boolean);

  return {
    canonical_name: name.slice(0, 300),
    source_key: GEM_SOURCE_KEY,
    source_unique_id: uniqueId.slice(0, 500),
    icp_code: cfg.icp,
    record_type: 'project',
    // BU follows the asset's geography (GEM is worldwide), not the tracker.
    bu: resolveGemBu(country, region),
    project_type: label,
    building_type: buildingType,
    description: descriptionParts.length ? descriptionParts.join(' · ').slice(0, 1000) : null,
    square_footage: null,
    address_line1: null,
    city,
    state_province: state ?? region,
    country: country ?? region,
    country_code: null,
    latitude: lat,
    longitude: lng,
    announced_date: announced,
    construction_start_date: constructionStart,
    estimated_completion_date: completion,
    bid_date: null,
    project_url: url,
    current_phase: status ? titleCase(status) : null,
    estimated_value: null,
    estimated_value_currency: null,
    company_name_raw: company,
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
    raw_data: { ...raw, __gem_tracker: tracker },
  };
}

function capacityUnit(row: Record<string, unknown>): string {
  if (row['Design capacity (ttpa)'] !== undefined) return 'ttpa';
  return 'MW';
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Normalize a whole file's worth of rows, counting failures instead of
 * throwing so one bad row never aborts a large upload.
 */
export function normalizeGemFile(
  rows: RawProjectRecord[],
  tracker: string
): { records: CanonicalProjectInsert[]; failed: number } {
  const records: CanonicalProjectInsert[] = [];
  let failed = 0;
  for (const row of rows) {
    try {
      records.push(normalizeGemRecord(row, tracker));
    } catch {
      failed += 1;
    }
  }
  return { records, failed };
}
