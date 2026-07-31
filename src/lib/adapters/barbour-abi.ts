import { createHash } from 'crypto';
import type { AdapterFetchParams, CanonicalProjectInsert, RawProjectRecord, SourceAdapter } from './types';
import { fetchWithRetry, AdapterAuthError, AdapterShapeError } from './types';
import { resolveCredentials } from './credentials';
import { computeCompleteness, isPresent } from '@/lib/completeness';
import type { CriticalField } from '@/lib/supabase/types';

/**
 * Barbour ABI adapter — ported from a working production adapter
 * (Desktop/L1_Evercam/next/lib/adapters/barbour-abi-adapter.ts) that has been
 * confirmed against a live key. Real auth flow: GET /login with HTTP Basic
 * (username : sha256(password)) + an `x-api-key` header returns a bearer
 * token in a response header (`authorization` / `x-auth-token` / `token`),
 * valid ~30 days — cached in-memory here and refreshed a day early.
 *
 * `FIELDS` below are the confirmed real response keys. Notably, Barbour ABI
 * does NOT expose company or contact fields through this endpoint — those
 * columns are intentionally left null rather than guessed.
 *
 * Requires a username, password and API key stored in `source_credentials`
 * (Settings → API Keys).
 */

const DEFAULT_BASE_URL = 'https://api.barbour-abi.com/v4';
const TOKEN_TTL_MS = 29 * 24 * 60 * 60 * 1000; // re-login a day early; docs say 30-day expiry

const FIELDS = [
  'project_id',
  'project_title',
  'project_value',
  'project_value_estimated',
  'project_site3',
  'project_site4',
  'project_postcode',
  'project_latitude',
  'project_longitude',
  'project_planning_stage_display',
  'project_primary_sector_display',
  'project_last_published',
  'project_start_display',
  'project_finish_display',
  'project_planning_url',
].join(',');

interface BarbourAbiRawProject {
  project_id: string;
  project_title?: string | null;
  project_value?: number | string | null;
  project_value_estimated?: boolean | null;
  project_site3?: string | null; // town/city
  project_site4?: string | null; // county/region
  project_postcode?: string | null;
  project_latitude?: number | null;
  project_longitude?: number | null;
  project_planning_stage_display?: string | null;
  project_primary_sector_display?: string | null;
  project_last_published?: string | null;
  project_start_display?: string | null;
  project_finish_display?: string | null;
  project_planning_url?: string | null;
}

// Module-scope token cache — persists across calls within the same warm
// serverless instance, matching the reference adapter's caching strategy.
let cachedToken: string | null = null;
let cachedTokenExpiresAt = 0;

async function getCredentials(override?: AdapterFetchParams['credentials']) {
  const base = await resolveCredentials('barbour_abi', DEFAULT_BASE_URL);
  if (!override) return base;
  return {
    apiKey: override.apiKey?.trim() || base.apiKey,
    apiSecret: override.apiSecret?.trim() || base.apiSecret,
    username: override.username?.trim() || base.username,
    baseUrl: override.baseUrl?.trim() || base.baseUrl,
  };
}

async function login(baseUrl: string, username: string, password: string, apiKey: string): Promise<string> {
  const passwordHash = createHash('sha256').update(password).digest('hex');
  const basic = Buffer.from(`${username}:${passwordHash}`).toString('base64');

  const res = await fetchWithRetry(`${baseUrl.replace(/\/$/, '')}/login`, {
    headers: {
      Authorization: `Basic ${basic}`,
      'x-api-key': apiKey,
      'User-Agent': 'EvercamSourceHub/1.0',
    },
  });
  if (!res.ok) {
    throw new Error(`Barbour ABI login failed: HTTP ${res.status} ${res.statusText}`);
  }
  const token =
    res.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    res.headers.get('x-auth-token') ??
    res.headers.get('token');
  if (!token) {
    throw new AdapterShapeError('Barbour ABI login succeeded but no token was found in the response headers.');
  }
  cachedToken = token;
  cachedTokenExpiresAt = Date.now() + TOKEN_TTL_MS;
  return token;
}

async function getToken(baseUrl: string, username: string, password: string, apiKey: string): Promise<string> {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;
  return login(baseUrl, username, password, apiKey);
}

export const barbourAbiAdapter: SourceAdapter = {
  sourceKey: 'barbour_abi',

  async isConfigured(): Promise<boolean> {
    const creds = await getCredentials();
    return Boolean(creds.apiKey && creds.username && creds.apiSecret && creds.baseUrl);
  },

  async fetchRawProjects(params: AdapterFetchParams = {}): Promise<RawProjectRecord[]> {
    const creds = await getCredentials(params.credentials);
    if (!creds.apiKey || !creds.username || !creds.apiSecret || !creds.baseUrl) {
      throw new Error(
        'Barbour ABI adapter is not configured — add a username, password and API key in /control/settings.'
      );
    }
    const baseUrl = creds.baseUrl;
    const token = await getToken(baseUrl, creds.username, creds.apiSecret, creds.apiKey);

    const pageSize = params.dryRun ? Math.min(params.pageSize ?? 5, 5) : (params.pageSize ?? 100);
    // Like Glenigan, default to a wide lookback rather than 24h — a
    // "new/updated since yesterday" window is frequently empty and easy to
    // mistake for a broken adapter.
    const since = params.since ?? new Date(Date.now() - 180 * 86_400_000);
    const offset = ((params.page ?? 1) - 1) * pageSize;

    // Barbour ABI's query language is a flat AND of single-operator conditions
    // keyed by field name (confirmed via the reference adapter). An upper
    // bound (`until`) isn't representable alongside a lower bound on the same
    // field without a documented compound-range syntax, so only `since` is
    // applied here.
    const conditions: Record<string, { operator: string; value: string | number | string[] }> = {
      project_last_published: { operator: '>=', value: since.toISOString() },
    };
    if (params.minValue) conditions.project_value = { operator: '>=', value: params.minValue };
    if (params.postcodes?.length) conditions.project_postcode = { operator: '=', value: params.postcodes };
    if (params.keyword?.trim()) conditions.project_text = { operator: '=', value: params.keyword.trim() };

    const url = new URL(`${baseUrl.replace(/\/$/, '')}/projects`);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('sort', '-project_last_published');
    url.searchParams.set('fields', FIELDS);
    url.searchParams.set('query', JSON.stringify(conditions));

    let res;
    try {
      res = await fetchWithRetry(
        url.toString(),
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'x-api-key': creds.apiKey,
            Accept: 'application/json',
            'User-Agent': 'EvercamSourceHub/1.0',
          },
        },
        { timeoutMs: 20_000 }
      );
    } catch (err) {
      if (err instanceof AdapterAuthError) {
        // Token may have expired server-side before our TTL guess — clear it so the next call re-logs in.
        cachedToken = null;
      }
      throw err;
    }

    if (!res.ok) {
      throw new Error(`Barbour ABI request failed: HTTP ${res.status} ${res.statusText}`);
    }

    let body: { projects?: RawProjectRecord[]; aggregation?: { project_count?: number } };
    try {
      body = await res.json();
    } catch {
      throw new AdapterShapeError('Barbour ABI response was not valid JSON.');
    }
    if (!body || !Array.isArray(body.projects)) {
      throw new AdapterShapeError('Barbour ABI response did not contain a "projects" array.');
    }

    return body.projects.slice(0, pageSize);
  },

  normalize(raw: RawProjectRecord): CanonicalProjectInsert {
    const p = raw as unknown as BarbourAbiRawProject;

    const projectName = p.project_title ?? null;
    const projectValue = typeof p.project_value === 'number' ? p.project_value : Number(p.project_value ?? NaN) || null;
    const town = p.project_site3 ?? null;
    const county = p.project_site4 ?? null;
    const phase = p.project_planning_stage_display ?? null;
    const sector = p.project_primary_sector_display ?? null;
    const announced = p.project_last_published ?? null;

    const presentFields: Partial<Record<CriticalField, boolean>> = {
      project_name: isPresent(projectName),
      project_value: isPresent(projectValue),
      project_location: isPresent(town) || isPresent(county) || isPresent(p.project_postcode),
      project_timeline: isPresent(p.project_start_display) || isPresent(announced),
      building_type: isPresent(sector),
      company_name: false, // not exposed by this source
      company_contact: false, // not exposed by this source
      project_phase: isPresent(phase),
      square_footage: false, // not exposed by this source
      funding_source: false, // not exposed by this source
      company_website: false, // not exposed by this source
      company_phone: false, // not exposed by this source
    };

    const completeness = computeCompleteness(presentFields);

    return {
      canonical_name: projectName ?? `Barbour ABI project ${p.project_id}`,
      source_key: 'barbour_abi',
      source_unique_id: String(p.project_id),
      icp_code: 'tier1_gc',
      record_type: 'project',
      bu: 'uk',
      project_type: sector,
      building_type: sector,
      description: [phase, p.project_value_estimated ? 'value estimated' : null].filter(Boolean).join(' — ') || null,
      address_line1: p.project_postcode ?? null,
      city: town,
      state_province: county,
      country: 'GB',
      country_code: 'GB',
      latitude: p.project_latitude ?? null,
      longitude: p.project_longitude ?? null,
      announced_date: normalizeDate(announced),
      construction_start_date: normalizeDate(p.project_start_display),
      estimated_completion_date: normalizeDate(p.project_finish_display),
      current_phase: phase,
      estimated_value: projectValue,
      estimated_value_currency: 'GBP',
      company_name_raw: null,
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

// project_start_display / project_finish_display are human-readable strings
// per Barbour ABI's docs, not guaranteed ISO — this is a best-effort parse
// that falls back to null rather than throwing on an unparseable string.
function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
