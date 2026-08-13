import { NextRequest, NextResponse } from 'next/server';
import { getLiveAdapter, LIVE_SOURCE_SLUGS } from '@/lib/adapters';
import { AdapterAuthError, AdapterNetworkError, AdapterShapeError } from '@/lib/adapters/types';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

const SOURCE_KEY_BY_SLUG: Record<string, string> = {
  'barbour-abi': 'barbour_abi',
  glenigan: 'glenigan',
  'construct-connect': 'construct_connect',
  'sam-gov': 'sam_gov',
  'sec-edgar': 'sec_edgar',
  'find-a-tender': 'find_a_tender_uk',
  austender: 'austender',
  'contracts-finder': 'contracts_finder_uk',
  ted: 'ted',
  'world-bank': 'world_bank',
  usaspending: 'usaspending_gov',
  'planning-ie': 'planning_ie',
};

type TestResult = 'success' | 'auth_error' | 'network_error' | 'unexpected_shape';

/** Records last_tested_at / last_test_result on source_credentials without touching api_key/base_url. */
async function recordTestResult(sourceKey: string, result: TestResult) {
  if (!isSupabaseServiceConfigured()) return;
  try {
    const supabase = getServiceSupabase();
    await supabase
      .from('source_credentials')
      .upsert(
        { source_key: sourceKey, last_tested_at: new Date().toISOString(), last_test_result: result },
        { onConflict: 'source_key' }
      );
  } catch {
    // Best-effort only — a logging failure should never break the test-connection response.
  }
}

/**
 * POST /api/ingest/[source]/test
 *
 * A lightweight "test connection" flow: fetches a single small page (1-5
 * records) using the resolved credentials (source_credentials DB row, or env
 * vars as a fallback) and reports back what it found, WITHOUT writing
 * anything to canonical_projects. Distinguishes auth errors, network errors,
 * and unexpected response shapes so the user can tell a bad API key apart
 * from a wrong base URL or a vendor API that no longer matches our assumed
 * shape. Also records last_tested_at/last_test_result on source_credentials.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ source: string }> }) {
  const auth = await checkPermission('sources.ingest');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const { source } = await context.params;
  const adapter = getLiveAdapter(source);
  const sourceKey = SOURCE_KEY_BY_SLUG[source];

  let body: {
    since?: string;
    until?: string;
    minValue?: number;
    keyword?: string;
    postcodes?: string[];
    sectors?: string[];
    regions?: string[];
  } = {};
  try {
    body = await request.json();
  } catch {
    // no body sent — fine, test with the adapter's default lookback window
  }

  if (!adapter) {
    return NextResponse.json(
      {
        // From the registry rather than a hardcoded list, which drifted for months
        // and named three sources when 29 were live.
        error: `Unknown or non-live source "${source}".`,
        liveSources: LIVE_SOURCE_SLUGS,
      },
      { status: 404 }
    );
  }

  if (!(await adapter.isConfigured())) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        message: 'Add this source’s API key in /admin/settings to enable a connection test.',
      },
      { status: 200 }
    );
  }

  try {
    const raw = await adapter.fetchRawProjects({
      dryRun: true,
      pageSize: 5,
      since: body.since ? new Date(body.since) : undefined,
      until: body.until ? new Date(body.until) : undefined,
      minValue: body.minValue,
      keyword: body.keyword,
      postcodes: body.postcodes,
      sectors: body.sectors,
      regions: body.regions,
    });

    if (raw.length === 0) {
      await recordTestResult(sourceKey, 'success');
      return NextResponse.json({
        ok: true,
        configured: true,
        message: 'Connected successfully, but the API returned zero records for this query.',
        sample: [],
        fieldsDetected: [],
      });
    }

    const normalized = raw.slice(0, 5).map((r) => {
      try {
        return adapter.normalize(r);
      } catch {
        return null;
      }
    });

    const fieldsDetected = Array.from(new Set(raw.flatMap((r) => Object.keys(r))));

    await recordTestResult(sourceKey, 'success');
    return NextResponse.json({
      ok: true,
      configured: true,
      message: `Connected successfully. Retrieved ${raw.length} sample record(s).`,
      sample: raw.slice(0, 5),
      normalizedSample: normalized,
      fieldsDetected,
    });
  } catch (err) {
    let kind: 'auth' | 'network' | 'shape' | 'unknown' = 'unknown';
    let dbResult: TestResult = 'network_error';
    if (err instanceof AdapterAuthError) {
      kind = 'auth';
      dbResult = 'auth_error';
    } else if (err instanceof AdapterNetworkError) {
      kind = 'network';
      dbResult = 'network_error';
    } else if (err instanceof AdapterShapeError) {
      kind = 'shape';
      dbResult = 'unexpected_shape';
    }

    await recordTestResult(sourceKey, dbResult);

    return NextResponse.json(
      {
        ok: false,
        configured: true,
        errorKind: kind,
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 200 }
    );
  }
}
