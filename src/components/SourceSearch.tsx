'use client';

import { Fragment, useEffect, useState } from 'react';
import EnrichPanel from './EnrichPanel';
import { type PriorityBand } from '@/lib/priority';
import {
  BAND_COLORS,
  BAND_LABELS,
  BU_COLORS,
  BU_LABELS,
  ICP_LABELS,
  RECORD_TYPE_COLORS,
  TIER_COLORS,
} from '@/lib/semantics';

/* ------------------------------------------------------------------ */
/* Per-source select catalogs — each API's REAL taxonomy */
/* ------------------------------------------------------------------ */

type SourceSlug =
  | 'glenigan'
  | 'barbour-abi'
  | 'construct-connect'
  | 'sam-gov'
  | 'sec-edgar'
  | 'find-a-tender'
  | 'austender'
  | 'contracts-finder'
  | 'ted'
  | 'world-bank'
  | 'usaspending'
  | 'planning-ie'
  | 'gem';

interface Catalog {
  label: string;
  icp: string;
  bu: string;
  currency: '£' | '$' | '€';
  auth: 'key' | 'userpass-key';
  keyless?: boolean; // no API key needed (e.g. SEC EDGAR)
  showPostcodes: boolean;
  showBuildingTypes: boolean;
  showValue: boolean; // whether a min-value filter is meaningful for this source
  valueUnit?: 'MW'; // when set, the "value" filter is a capacity threshold (GEM), not currency
  buOptions?: string[]; // when set, show a Business Unit chip filter (GEM) sent as `businessUnits`
  phasesAsForms?: boolean; // send the "phases" chip selection as the `forms` param (SEC EDGAR)
  showStage?: boolean; // UK OCDS feeds: filter by point in the procurement lifecycle
  labels: { sectors: string; regions: string; phases: string; buildingTypes: string };
  sectors: string[];
  regions: string[];
  phases: string[];
  buildingTypes: string[];
}

const UK_SECTORS = [
  'Private Housing',
  'Social Housing',
  'Health',
  'Education',
  'Retail',
  'Offices',
  'Industrial',
  'Light Industrial',
  'Hotel & Leisure',
  'Community & Amenity',
  'Infrastructure',
  'Utilities',
  'Sport & Recreation',
  'Agriculture',
];
const UK_REGIONS = [
  'North East',
  'North West',
  'Yorkshire & Humber',
  'East Midlands',
  'West Midlands',
  'East of England',
  'London',
  'South East',
  'South West',
  'Wales',
  'Scotland',
  'Northern Ireland',
];
const UK_PHASES = [
  'Early Planning',
  'Detailed Plans Submitted',
  'Plans Approved',
  'Pre-Tender',
  'Tender',
  'Contract Awarded',
  'On Site',
  'Complete',
];
const UK_BUILDING_TYPES = [
  'Apartments, Flats',
  'Houses',
  'Supermarkets',
  'Health Centres/Surgeries',
  'Hospitals',
  'Schools',
  'Office Buildings',
  'Warehouses',
  'Hotels',
  'Data Centres',
];

// ConstructConnect taxonomy — derived from real ProjectLeads response values.
const CC_CATEGORIES = [
  'Roads / Highways',
  'Water / Sewer',
  'Educational',
  'Municipal',
  'Sidewalks / Parking Lot',
  'Bridges / Tunnels',
  'Office',
  'Retail',
  'Multi-Residential',
  'Medical',
  'Industrial',
  'Manufacturing',
  'Warehouse / Distribution',
  'Parking Garage',
  'Library',
  'Laboratories',
  'Playgrounds / Parks / Athletic Fields',
  'Arenas / Stadiums',
  'Jails / Prisons',
  'Fitness / Rec Centers',
];
const CC_STATES = [
  'California',
  'Texas',
  'New York',
  'Florida',
  'Illinois',
  'Pennsylvania',
  'Ohio',
  'Georgia',
  'North Carolina',
  'Michigan',
  'Washington',
  'Oregon',
  'Virginia',
  'Massachusetts',
  'Minnesota',
  'Wisconsin',
  'Missouri',
  'Connecticut',
  'Nebraska',
  'Oklahoma',
  'Mississippi',
];
const CC_STATUSES = [
  'Conceptual',
  'Design',
  'Final Planning',
  'Pre-Construction/Negotiated',
  'Sub-Bidding',
  'Bid Results',
  'Post-Bid',
  'Award',
  'Under Construction',
  'Occupancy',
];

// SAM.gov taxonomy — NAICS 23 construction codes (value carries the code the
// adapter passes to `naicsCode`), US states, and federal notice types.
const SAM_NAICS = [
  '236210 Industrial Building',
  '236220 Commercial/Institutional Building',
  '237110 Water & Sewer Line',
  '237130 Power & Communication Line',
  '237310 Highway/Street/Bridge',
  '237990 Other Heavy & Civil',
  '236115 New Single-Family',
  '236116 New Multifamily',
];
const SAM_NOTICE_TYPES = [
  'Presolicitation',
  'Solicitation',
  'Combined Synopsis/Solicitation',
  'Sources Sought',
  'Special Notice',
  'Award Notice',
  'Justification',
];

// SEC EDGAR — capex signal terms (OR-combined into the full-text query) and
// filing form types (the `forms` param).
const EDGAR_SIGNALS = [
  'data center',
  'gigafactory',
  'semiconductor fab',
  'battery plant',
  'pharmaceutical facility',
  'biotech facility',
  'distribution center',
  'food production facility',
  'new manufacturing plant',
];
const EDGAR_FORMS = ['8-K', '10-K', '10-Q', 'S-1', '20-F', '6-K'];

// AusTender buyer-address regions are Australian state codes.
const AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
// TED country filter — chip labels map to ISO-3 codes server-side (see ted.ts).
const TED_COUNTRIES = [
  'Ireland',
  'United Kingdom',
  'France',
  'Germany',
  'Netherlands',
  'Spain',
  'Italy',
  'Poland',
  'Belgium',
  'Sweden',
];

// World Bank region names (used as the region filter, server-side).
const WB_REGIONS = [
  'Africa East',
  'Africa West',
  'East Asia and Pacific',
  'Europe and Central Asia',
  'Latin America And Caribbean',
  'Middle East And North Africa',
  'South Asia',
];

// Irish planning authorities (used as the region filter, server-side).
const IE_COUNCILS = [
  'Dublin City Council',
  'Dun Laoghaire Rathdown County Council',
  'Fingal County Council',
  'South Dublin County Council',
  'Cork City Council',
  'Cork County Council',
  'Galway City Council',
  'Limerick City and County Council',
  'Kildare County Council',
  'Meath County Council',
  'Wicklow County Council',
];

// GEM (Global Energy Monitor) taxonomy — tracker slugs (match the folder's
// filenames), operating statuses (matched against current_phase server-side),
// and GEM country/region names used for the region substring filter.
const GEM_TRACKERS = [
  'solar',
  'wind',
  'nuclear',
  'hydro',
  'geo',
  'bio',
  'coal_plant',
  'coal_mine',
  'coal_terminal',
  'oil_gas_plant',
  'oil_gas_extraction',
  'gas_pipeline',
  'oil_ngl_pipeline',
  'lng',
  'iron_ore_mine',
  'steel',
  'cement',
  'chemicals',
];
const GEM_STATUSES = [
  'announced',
  'pre-construction',
  'construction',
  'operating',
  'mothballed',
  'retired',
  'cancelled',
  'shelved',
];
// Business units GEM records are split into by geography (sent as `businessUnits`,
// matched case-insensitively against the record's resolved BU).
const GEM_BUS = ['USA', 'UK', 'Ireland', 'APAC', 'Export'];
// Region filter matches against country, GEM region, AND state/province — so it
// works both for US-scoped exports (filter by state) and global exports (filter
// by country/region). States lead since GEM exports are often single-country.
const GEM_REGIONS = [
  'California',
  'Texas',
  'Florida',
  'New York',
  'Illinois',
  'Pennsylvania',
  'Ohio',
  'Arizona',
  'Nevada',
  'Virginia',
  'Georgia',
  'Washington',
  'United States',
  'China',
  'India',
  'United Kingdom',
  'Germany',
  'Australia',
  'North America',
  'Europe',
  'East Asia',
  'South Asia',
  'Middle East',
  'Africa',
];

const UK_LABELS = { sectors: 'Sectors', regions: 'Regions', phases: 'Project phase', buildingTypes: 'Building types' };

const CATALOGS: Record<SourceSlug, Catalog> = {
  glenigan: {
    label: 'Glenigan',
    icp: 'Tier 1 GC',
    bu: 'uk',
    currency: '£',
    auth: 'key',
    showPostcodes: false,
    showBuildingTypes: true,
    showValue: true,
    labels: UK_LABELS,
    sectors: UK_SECTORS,
    regions: UK_REGIONS,
    phases: UK_PHASES,
    buildingTypes: UK_BUILDING_TYPES,
  },
  'barbour-abi': {
    label: 'Barbour ABI',
    icp: 'Tier 1 GC',
    bu: 'uk',
    currency: '£',
    auth: 'userpass-key',
    showPostcodes: true,
    showBuildingTypes: true,
    showValue: true,
    labels: UK_LABELS,
    sectors: UK_SECTORS,
    regions: UK_REGIONS,
    phases: UK_PHASES,
    buildingTypes: UK_BUILDING_TYPES,
  },
  'construct-connect': {
    label: 'ConstructConnect',
    icp: 'Tier 1 GC',
    bu: 'usa',
    currency: '$',
    auth: 'key',
    showPostcodes: false,
    showBuildingTypes: false,
    showValue: true,
    labels: { sectors: 'Categories', regions: 'States', phases: 'Project status', buildingTypes: 'Building types' },
    sectors: CC_CATEGORIES,
    regions: CC_STATES,
    phases: CC_STATUSES,
    buildingTypes: [],
  },
  'sam-gov': {
    label: 'SAM.gov',
    icp: 'Critical Infrastructure Owner',
    bu: 'usa',
    currency: '$',
    auth: 'key',
    showPostcodes: false,
    showBuildingTypes: false,
    showValue: true,
    labels: { sectors: 'NAICS category', regions: 'States', phases: 'Notice type', buildingTypes: 'Building types' },
    sectors: SAM_NAICS,
    regions: CC_STATES,
    phases: SAM_NOTICE_TYPES,
    buildingTypes: [],
  },
  'sec-edgar': {
    label: 'SEC EDGAR',
    icp: 'Mission-Critical Owner',
    bu: 'export',
    currency: '$',
    auth: 'key',
    keyless: true,
    showPostcodes: false,
    showBuildingTypes: false,
    showValue: false,
    phasesAsForms: true,
    labels: { sectors: 'Capex signal', regions: 'States', phases: 'Filing form', buildingTypes: 'Building types' },
    sectors: EDGAR_SIGNALS,
    regions: CC_STATES,
    phases: EDGAR_FORMS,
    buildingTypes: [],
  },
  'find-a-tender': {
    label: 'Find a Tender (UK)',
    showStage: true,
    icp: 'Critical Infrastructure Owner',
    bu: 'uk',
    currency: '£',
    auth: 'key',
    keyless: true,
    showPostcodes: false,
    showBuildingTypes: false,
    showValue: true,
    labels: { sectors: 'Sectors', regions: 'Buyer region', phases: 'Project phase', buildingTypes: 'Building types' },
    sectors: [],
    regions: UK_REGIONS,
    phases: [],
    buildingTypes: [],
  },
  austender: {
    label: 'AusTender (Australia)',
    icp: 'Critical Infrastructure Owner',
    bu: 'apac',
    currency: '$',
    auth: 'key',
    keyless: true,
    showPostcodes: false,
    showBuildingTypes: false,
    showValue: true,
    labels: { sectors: 'Sectors', regions: 'State', phases: 'Project phase', buildingTypes: 'Building types' },
    sectors: [],
    regions: AU_STATES,
    phases: [],
    buildingTypes: [],
  },
  'contracts-finder': {
    label: 'Contracts Finder (UK)',
    showStage: true,
    icp: 'Critical Infrastructure Owner',
    bu: 'uk',
    currency: '£',
    auth: 'key',
    keyless: true,
    showPostcodes: false,
    showBuildingTypes: false,
    showValue: true,
    labels: { sectors: 'Sectors', regions: 'Buyer region', phases: 'Project phase', buildingTypes: 'Building types' },
    sectors: [],
    regions: UK_REGIONS,
    phases: [],
    buildingTypes: [],
  },
  ted: {
    label: 'TED (EU / Ireland)',
    icp: 'Tier 1 GC',
    bu: 'ireland',
    currency: '€',
    auth: 'key',
    keyless: true,
    showPostcodes: false,
    showBuildingTypes: false,
    showValue: true,
    labels: { sectors: 'Sectors', regions: 'Country', phases: 'Project phase', buildingTypes: 'Building types' },
    sectors: [],
    regions: TED_COUNTRIES,
    phases: [],
    buildingTypes: [],
  },
  'world-bank': {
    label: 'World Bank Projects',
    icp: 'Critical Infrastructure Owner',
    bu: 'export',
    currency: '$',
    auth: 'key',
    keyless: true,
    showPostcodes: false,
    showBuildingTypes: false,
    showValue: true,
    labels: { sectors: 'Sectors', regions: 'WB region', phases: 'Project phase', buildingTypes: 'Building types' },
    sectors: [],
    regions: WB_REGIONS,
    phases: [],
    buildingTypes: [],
  },
  usaspending: {
    label: 'USASpending.gov',
    icp: 'Tier 1 GC',
    bu: 'usa',
    currency: '$',
    auth: 'key',
    keyless: true,
    showPostcodes: false,
    showBuildingTypes: false,
    showValue: true,
    labels: { sectors: 'NAICS category', regions: 'State', phases: 'Project phase', buildingTypes: 'Building types' },
    sectors: SAM_NAICS,
    regions: CC_STATES,
    phases: [],
    buildingTypes: [],
  },
  'planning-ie': {
    label: 'Planning IE',
    icp: 'Tier 1 GC',
    bu: 'ireland',
    currency: '€',
    auth: 'key',
    keyless: true,
    showPostcodes: false,
    showBuildingTypes: false,
    showValue: true,
    labels: {
      sectors: 'Sectors',
      regions: 'Planning authority',
      phases: 'Application status',
      buildingTypes: 'Building types',
    },
    sectors: [],
    regions: IE_COUNCILS,
    phases: ['Granted', 'Refused', 'Pending', 'Withdrawn', 'Appealed'],
    buildingTypes: [],
  },
  gem: {
    label: 'GEM Trackers',
    icp: 'Critical Infrastructure Owner',
    bu: 'export',
    currency: '$',
    auth: 'key',
    keyless: true,
    showPostcodes: false,
    showBuildingTypes: false,
    showValue: true,
    valueUnit: 'MW',
    buOptions: GEM_BUS,
    labels: { sectors: 'Tracker', regions: 'Country / region', phases: 'Status', buildingTypes: 'Building types' },
    sectors: GEM_TRACKERS,
    regions: GEM_REGIONS,
    phases: GEM_STATUSES,
    buildingTypes: [],
  },
};

function valuePresets(currency: '£' | '$' | '€') {
  return [
    { label: 'Any value', value: '' as number | '' },
    { label: `${currency}100k+`, value: 100_000 },
    { label: `${currency}500k+`, value: 500_000 },
    { label: `${currency}1m+`, value: 1_000_000 },
    { label: `${currency}5m+`, value: 5_000_000 },
    { label: `${currency}10m+`, value: 10_000_000 },
    { label: `${currency}50m+`, value: 50_000_000 },
  ];
}

// GEM has no monetary value — the "value" filter is a capacity threshold (MW).
function capacityPresets() {
  return [
    { label: 'Any capacity', value: '' as number | '' },
    { label: '10 MW+', value: 10 },
    { label: '50 MW+', value: 50 },
    { label: '100 MW+', value: 100 },
    { label: '500 MW+', value: 500 },
    { label: '1 GW+', value: 1_000 },
    { label: '2 GW+', value: 2_000 },
  ];
}

const PAGE_SIZES = [10, 25, 50, 100, 200];

interface NormalizedResult {
  canonical_name: string;
  source_key: string;
  icp_code: string | null;
  record_type: string | null;
  bu: string | null;
  building_type: string | null;
  city: string | null;
  state_province: string | null;
  current_phase: string | null;
  estimated_value: number | null;
  estimated_value_currency: string | null;
  company_name_raw: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  bid_date: string | null;
  project_url: string | null;
  source_completeness_tier: string;
  source_completeness_score: number;
  fields_missing: string[];
  // classification attached by the search route (mirrors the DB generated cols)
  ref_code?: string;
  vertical?: string;
  contact_status?: 'has_contact' | 'needs_enrichment';
  org_path?: string;
  // priority attached by the search route (same policy the DB pass uses)
  priority_score?: number;
  priority_band?: PriorityBand;
  priority_reasons?: string[];
}

interface SearchResponse {
  ok: boolean;
  count?: number;
  rawCount?: number;
  results?: NormalizedResult[];
  /** Where the credentials for this run came from. */
  credentialOrigin?: 'request' | 'saved' | 'env' | 'none';
  message?: string;
  errorKind?: string;
}

interface CredentialStatus {
  configured: boolean;
  origin: 'saved' | 'none';
  keyless: boolean;
}

function money(v: number | null, ccy: string | null): string {
  if (v === null || v === undefined) return '—';
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: ccy || 'GBP',
      maximumFractionDigits: 0,
    }).format(v);
  } catch {
    return `${ccy ?? ''} ${v.toLocaleString()}`;
  }
}

function fmtDate(v: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: '2-digit' });
}

/**
 * The window starts today unless someone widens it.
 *
 * It used to open three years back, which meant every search — and every
 * schedule saved from one — re-pulled the entire history of a source on each
 * run. A daily pull wants today's changes; reaching further is a deliberate
 * act, so it is one the user performs rather than one they inherit.
 */
function defaultSince(): string {
  return today();
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ChipMultiSelect({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div>
      <span className="text-xs font-medium text-muted">{label}</span>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const on = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onToggle(opt)}
              className={`rounded-full border px-2.5 py-1 text-xs transition ${
                on
                  ? 'border-border-base bg-brand text-brand-contrast'
                  : 'border-border-base bg-surface text-muted hover:border-border-base'
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Query one source.
 *
 * `fixedSource` pins the component to a single adapter and hides its own
 * selector — that is how the Source Hub embeds it inside a row, so the source
 * you are looking at is the source you are querying. Without a fixed source it
 * still works standalone with a dropdown.
 */
export default function SourceSearch({
  fixedSource,
  onSaveQuery,
}: {
  fixedSource?: SourceSlug;
  /** When given, a "Save as scheduled query" action appears beside Run Search. */
  onSaveQuery?: (params: Record<string, unknown>) => Promise<void> | void;
} = {}) {
  const [source, setSource] = useState<SourceSlug>(fixedSource ?? 'glenigan');
  const cat = CATALOGS[source];

  // Credentials (kept only in component state — never persisted)

  // Filters
  const [stage, setStage] = useState<'' | 'planning' | 'tender' | 'award'>('');
  const [since, setSince] = useState(defaultSince());
  const [until, setUntil] = useState(today());
  const [minValue, setMinValue] = useState<number | ''>('');
  const [keyword, setKeyword] = useState('');
  const [postcodes, setPostcodes] = useState('');
  const [pageSize, setPageSize] = useState(50);
  const [sectors, setSectors] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [phases, setPhases] = useState<string[]>([]);
  const [buildingTypes, setBuildingTypes] = useState<string[]>([]);
  const [businessUnits, setBusinessUnits] = useState<string[]>([]);

  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [enrichOpen, setEnrichOpen] = useState<number | null>(null);

  // Which sources already have credentials server-side (saved in /settings or
  // env). When one does, the key field becomes an optional override instead of
  // a requirement — see /api/credentials/status.
  const [credStatuses, setCredStatuses] = useState<Record<string, CredentialStatus>>({});
  const saved = credStatuses[source];
  const hasSavedCredentials = Boolean(saved?.configured && !saved.keyless);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/credentials/status')
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j?.ok) setCredStatuses(j.statuses as Record<string, CredentialStatus>);
      })
      .catch(() => {
        // status is an affordance, not a gate — the route still validates
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(list: string[], setList: (v: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  function clearFilters() {
    setSince(defaultSince());
    setUntil(today());
    setMinValue('');
    setKeyword('');
    setPostcodes('');
    setPageSize(50);
    setSectors([]);
    setRegions([]);
    setPhases([]);
    setBuildingTypes([]);
    setBusinessUnits([]);
    setStage('');
  }

  function switchSource(next: SourceSlug) {
    setSource(next);
    setResponse(null);
    clearFilters();
  }

  /**
   * The filter payload, in the shape both /api/search and /api/ingest accept.
   *
   * No credentials travel with it. Keys live in Settings, encrypted, and the
   * server resolves them per source — this panel used to offer its own key and
   * base-URL inputs, which meant two places to configure the same source and
   * only one of them persisting anything.
   *
   * `forQuery` additionally drops the date window: a fixed `since` would
   * freeze a saved schedule to a date in the past, and the adapter's own
   * default window is what a recurring pull wants.
   */
  function buildPayload(forQuery = false): Record<string, unknown> {
    const payload: Record<string, unknown> = forQuery ? { pageSize } : { since, until, pageSize };
    if (cat.showStage && stage) payload.stage = stage;
    if (cat.showValue && minValue) payload.minValue = minValue;
    if (keyword.trim()) payload.keyword = keyword.trim();
    if (cat.showPostcodes && postcodes.trim())
      payload.postcodes = postcodes
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    if (sectors.length) payload.sectors = sectors;
    if (regions.length) payload.regions = regions;
    // SEC EDGAR: the "phases" chips are filing-form types -> the `forms` param.
    if (phases.length) {
      if (cat.phasesAsForms) payload.forms = phases;
      else payload.phases = phases;
    }
    if (buildingTypes.length) payload.buildingTypes = buildingTypes;
    if (cat.buOptions && businessUnits.length) payload.businessUnits = businessUnits;

    return payload;
  }

  async function runSearch() {
    setLoading(true);
    setResponse(null);
    try {
      const res = await fetch(`/api/search/${source}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      setResponse((await res.json()) as SearchResponse);
    } catch (err) {
      setResponse({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }

  const presets = cat.valueUnit === 'MW' ? capacityPresets() : valuePresets(cat.currency);

  return (
    <div className="space-y-6">
      {/* Source + credentials */}
      <div className="rounded-lg border border-border-base bg-surface p-5">
        <div className="flex flex-wrap items-end gap-4">
          {fixedSource ? null : (
            <label className="text-xs font-medium text-muted">
              Source
              <select
                value={source}
                onChange={(e) => switchSource(e.target.value as SourceSlug)}
                className="mt-1 block w-48 rounded border border-border-base bg-surface px-2 py-1.5 text-sm text-foreground"
              >
                <option value="glenigan">Glenigan</option>
                <option value="barbour-abi">Barbour ABI</option>
                <option value="construct-connect">ConstructConnect</option>
                <option value="sam-gov">SAM.gov</option>
                <option value="sec-edgar">SEC EDGAR</option>
                <option value="find-a-tender">Find a Tender (UK)</option>
                <option value="austender">AusTender (Australia)</option>
                <option value="contracts-finder">Contracts Finder (UK)</option>
                <option value="ted">TED (EU / Ireland)</option>
                <option value="world-bank">World Bank Projects (Export)</option>
                <option value="usaspending">USASpending.gov (USA)</option>
                <option value="planning-ie">Planning IE (Ireland)</option>
                <option value="gem">GEM Trackers (energy / mining, uploaded)</option>
              </select>
            </label>
          )}

          <div className="flex items-center gap-2 pb-1.5">
            <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300">
              ICP: {cat.icp}
            </span>
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${BU_COLORS[cat.bu] ?? ''}`}>
              BU: {BU_LABELS[cat.bu] ?? cat.bu}
            </span>
          </div>

          {cat.keyless ? (
            <div className="pb-1.5">
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                No API key required
              </span>
            </div>
          ) : hasSavedCredentials ? (
            <div className="flex items-center gap-2 pb-1.5">
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                ● Using saved credentials
              </span>
            </div>
          ) : null}

          {!cat.keyless && !hasSavedCredentials ? (
            <div className="flex items-center gap-2 pb-1.5">
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                No key saved
              </span>
              <a
                href="/admin/settings"
                className="text-muted hover:text-foreground text-xs underline underline-offset-2"
              >
                Add one in Settings
              </a>
            </div>
          ) : null}
        </div>

        <p className="text-muted mt-2 text-[11px]">
          Credentials and the base URL come from Settings. Querying here writes nothing to the database.
        </p>
      </div>

      {/* Filters */}
      <div className="space-y-4 rounded-lg border border-border-base bg-surface p-5">
        <div className="flex flex-wrap items-end gap-4">
          {cat.showStage ? (
            <label className="text-muted text-xs font-medium">
              Notice stage
              <select
                value={stage}
                onChange={(e) => setStage(e.target.value as typeof stage)}
                className="border-border-base bg-surface mt-1 block w-52 rounded border px-2 py-1.5 text-sm"
              >
                <option value="">Every stage</option>
                <option value="planning">Planning — intention to buy</option>
                <option value="tender">Tender — open, still biddable</option>
                <option value="award">Award — contractor chosen</option>
              </select>
            </label>
          ) : null}

          <label className="text-xs font-medium text-muted">
            Since
            <input
              type="date"
              value={since}
              max={until || undefined}
              onChange={(e) => setSince(e.target.value)}
              className="mt-1 block rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs font-medium text-muted">
            Until
            <input
              type="date"
              value={until}
              min={since || undefined}
              onChange={(e) => setUntil(e.target.value)}
              className="mt-1 block rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
            />
          </label>
          {cat.showValue ? (
            <label className="text-xs font-medium text-muted">
              {cat.valueUnit === 'MW' ? 'Min capacity' : 'Min value'}
              <select
                value={minValue}
                onChange={(e) => setMinValue(e.target.value === '' ? '' : Number(e.target.value))}
                className="mt-1 block w-32 rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
              >
                {presets.map((p) => (
                  <option key={p.label} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="text-xs font-medium text-muted">
            Max results
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="mt-1 block w-24 rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex-1 text-xs font-medium text-muted">
            Keyword
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Title / description contains…"
              className="mt-1 block w-full rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
            />
          </label>
        </div>

        <ChipMultiSelect
          label={cat.labels.sectors}
          options={cat.sectors}
          selected={sectors}
          onToggle={(v) => toggle(sectors, setSectors, v)}
        />
        {cat.buOptions ? (
          <ChipMultiSelect
            label="Business unit"
            options={cat.buOptions}
            selected={businessUnits}
            onToggle={(v) => toggle(businessUnits, setBusinessUnits, v)}
          />
        ) : null}
        <ChipMultiSelect
          label={cat.labels.regions}
          options={cat.regions}
          selected={regions}
          onToggle={(v) => toggle(regions, setRegions, v)}
        />
        {cat.showBuildingTypes ? (
          <ChipMultiSelect
            label={cat.labels.buildingTypes}
            options={cat.buildingTypes}
            selected={buildingTypes}
            onToggle={(v) => toggle(buildingTypes, setBuildingTypes, v)}
          />
        ) : null}
        <ChipMultiSelect
          label={cat.labels.phases}
          options={cat.phases}
          selected={phases}
          onToggle={(v) => toggle(phases, setPhases, v)}
        />

        {cat.showPostcodes ? (
          <label className="block text-xs font-medium text-muted">
            Postcodes (comma-separated, server-side filter)
            <input
              value={postcodes}
              onChange={(e) => setPostcodes(e.target.value)}
              placeholder="e.g. NE1, NE6, SW1"
              className="mt-1 block w-full max-w-md rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
            />
          </label>
        ) : null}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={runSearch}
            disabled={loading}
            className="rounded bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-surface-raised disabled:opacity-50-raised"
          >
            {loading ? 'Searching…' : 'Run Search'}
          </button>
          {onSaveQuery ? (
            <button
              onClick={() => onSaveQuery(buildPayload(true))}
              disabled={loading}
              className="border-brand/40 bg-brand/10 text-brand hover:bg-brand/15 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50"
              title="These filters become what the scheduled ingest pulls"
            >
              Save as scheduled query
            </button>
          ) : null}
          <button
            onClick={clearFilters}
            disabled={loading}
            className="rounded border border-border-base px-3 py-2 text-sm font-medium text-muted hover:bg-surface-raised disabled:opacity-50-raised"
          >
            Reset filters
          </button>
          <span className="text-[11px] text-muted">
            {source === 'barbour-abi'
              ? 'Value/keyword/postcode run server-side; sector/region client-side.'
              : source === 'glenigan'
                ? 'Sector/region/value/keyword filters run client-side after fetch.'
                : source === 'sam-gov'
                  ? 'Date, keyword & NAICS (first selected) run server-side; state/notice-type/value client-side.'
                  : source === 'sec-edgar'
                    ? 'Keyless. Query terms, filing form & date run server-side; state client-side. Early capex signal — Tier D by design.'
                    : source === 'ted'
                      ? 'Keyless EU procurement. Country & date run server-side (defaults to Ireland); keyword full-text server-side.'
                      : source === 'find-a-tender' || source === 'austender' || source === 'contracts-finder'
                        ? 'Keyless OCDS procurement — carries named buyer contact (name/email/phone). Date runs server-side; keyword/value/region client-side.'
                        : source === 'world-bank'
                          ? 'Keyless global major-projects feed (Export BU). Keyword & region run server-side; value client-side. Enrich to resolve contacts.'
                          : source === 'usaspending'
                            ? 'Keyless US federal awards — the winning contractor is the account. Date/keyword/NAICS/value run server-side; state client-side.'
                            : 'Category/min-value run server-side; state/status/keyword client-side.'}
          </span>
        </div>
      </div>

      {/* Results */}
      {response ? (
        <div className="rounded-lg border border-border-base bg-surface">
          {!response.ok ? (
            <p className="px-5 py-4 text-sm text-rose-600 dark:text-rose-400">
              {response.errorKind ? `[${response.errorKind}] ` : ''}
              {response.message}
            </p>
          ) : (
            <>
              <p className="border-b border-border-base px-5 py-3 text-sm text-muted">
                <strong className="text-foreground">{response.count}</strong> result
                {response.count === 1 ? '' : 's'} after filtering
                {response.rawCount !== undefined ? ` (${response.rawCount} fetched from source)` : ''}, ranked by
                priority.
                {response.credentialOrigin && response.credentialOrigin !== 'none' ? (
                  <span className="ml-1 text-muted">
                    Ran with{' '}
                    {response.credentialOrigin === 'request'
                      ? 'the key you entered'
                      : `${response.credentialOrigin} credentials`}
                    .
                  </span>
                ) : null}
              </p>
              {response.results && response.results.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-surface-raised text-xs uppercase text-muted">
                      <tr>
                        <th className="px-4 py-2">Priority</th>
                        <th className="px-4 py-2">Project</th>
                        <th className="px-4 py-2">Record</th>
                        <th className="px-4 py-2">BU</th>
                        <th className="px-4 py-2">ICP</th>
                        <th className="px-4 py-2">Type</th>
                        <th className="px-4 py-2">Location</th>
                        <th className="px-4 py-2">Value</th>
                        <th className="px-4 py-2">Phase</th>
                        <th className="px-4 py-2">Bid date</th>
                        <th className="px-4 py-2">Company</th>
                        <th className="px-4 py-2">Contact</th>
                        <th className="px-4 py-2">Tier</th>
                        <th className="px-4 py-2">Enrich</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-base">
                      {response.results.map((r, i) => (
                        <Fragment key={i}>
                          <tr className="align-top">
                            <td className="px-4 py-2">
                              {r.priority_band ? (
                                <span
                                  className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${BAND_COLORS[r.priority_band]}`}
                                  title={r.priority_reasons?.join(' · ') || BAND_LABELS[r.priority_band]}
                                >
                                  {r.priority_band} · {r.priority_score}
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-4 py-2 font-medium text-foreground">
                              {r.project_url ? (
                                <a href={r.project_url} target="_blank" rel="noreferrer" className="hover:underline">
                                  {r.canonical_name}
                                </a>
                              ) : (
                                r.canonical_name
                              )}
                              {r.ref_code ? (
                                <span
                                  className="mt-0.5 block font-mono text-[10px] font-normal text-muted"
                                  title={r.org_path}
                                >
                                  {r.ref_code}
                                </span>
                              ) : null}
                            </td>
                            <td className="px-4 py-2">
                              {r.record_type ? (
                                <span
                                  className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${RECORD_TYPE_COLORS[r.record_type] ?? 'bg-surface-raised text-muted'}`}
                                >
                                  {r.record_type}
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-4 py-2">
                              {r.bu ? (
                                <span
                                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${BU_COLORS[r.bu] ?? ''}`}
                                >
                                  {BU_LABELS[r.bu] ?? r.bu}
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-4 py-2">
                              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300">
                                {r.icp_code ? (ICP_LABELS[r.icp_code] ?? r.icp_code) : '—'}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-muted">{r.building_type ?? '—'}</td>
                            <td className="px-4 py-2 text-muted">
                              {[r.city, r.state_province].filter(Boolean).join(', ') || '—'}
                            </td>
                            <td className="px-4 py-2 text-muted">
                              {money(r.estimated_value, r.estimated_value_currency)}
                            </td>
                            <td className="px-4 py-2 text-muted">{r.current_phase ?? '—'}</td>
                            <td className="px-4 py-2 text-muted">{fmtDate(r.bid_date)}</td>
                            <td className="px-4 py-2 text-muted">{r.company_name_raw ?? '—'}</td>
                            <td className="px-4 py-2 text-muted">
                              {r.contact_status === 'needs_enrichment' ? (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                                  needs enrichment
                                </span>
                              ) : (
                                <>
                                  {r.contact_name ? <span className="block">{r.contact_name}</span> : null}
                                  {r.contact_email ? (
                                    <span className="block text-[11px] text-sky-600 dark:text-sky-400">
                                      {r.contact_email}
                                    </span>
                                  ) : null}
                                  {r.contact_phone ? (
                                    <span className="block text-[11px] text-muted">{r.contact_phone}</span>
                                  ) : null}
                                </>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              <span
                                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TIER_COLORS[r.source_completeness_tier] ?? ''}`}
                              >
                                {r.source_completeness_tier} · {r.source_completeness_score}%
                              </span>
                            </td>
                            <td className="px-4 py-2">
                              <button
                                type="button"
                                onClick={() => setEnrichOpen(enrichOpen === i ? null : i)}
                                className="rounded border border-indigo-300 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                              >
                                {enrichOpen === i ? 'Hide' : 'Enrich'}
                              </button>
                            </td>
                          </tr>
                          {enrichOpen === i ? (
                            <tr>
                              <td colSpan={14} className="p-0">
                                <EnrichPanel
                                  record={{
                                    canonical_name: r.canonical_name,
                                    record_type: r.record_type,
                                    icp_code: r.icp_code,
                                    company_name_raw: r.company_name_raw,
                                    contact_name: r.contact_name,
                                    contact_email: r.contact_email,
                                    contact_phone: r.contact_phone,
                                    city: r.city,
                                    state_province: r.state_province,
                                    estimated_value: r.estimated_value,
                                    estimated_value_currency: r.estimated_value_currency,
                                    source_key: r.source_key,
                                    project_url: r.project_url,
                                  }}
                                />
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-muted">
                  No projects matched. Try widening the date range or clearing filters.
                </p>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
