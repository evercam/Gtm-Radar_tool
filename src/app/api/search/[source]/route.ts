import { NextRequest, NextResponse } from 'next/server';
import { getLiveAdapter } from '@/lib/adapters';
import { AdapterAuthError, AdapterNetworkError, AdapterShapeError } from '@/lib/adapters/types';
import { classify } from '@/lib/classify';
import { getCredentialStatus } from '@/lib/adapters/credentialStatus';
import { getScoringPolicy } from '@/lib/policies';
import { scorePriority } from '@/lib/priority';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * POST /api/search/[source]
 *
 * A stateless, NO-PERSISTENCE search: runs the adapter and returns normalized
 * results inline. Nothing is written to canonical_projects — use
 * `/api/ingest/*` when you DO want results persisted.
 *
 * Credentials are optional in the body. A key passed here is used for this
 * one query and never saved; when the field is left empty the adapter falls
 * back to the saved `source_credentials` row (from /settings) and then to env
 * vars, so a configured source needs no typing at all. Only when NONE of the
 * three resolve do we refuse.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ source: string }> }) {
  const auth = await checkPermission('sources.run');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const { source } = await context.params;
  const adapter = getLiveAdapter(source);

  if (!adapter) {
    return NextResponse.json(
      { ok: false, message: `Unknown source "${source}". Only barbour-abi and glenigan are searchable.` },
      { status: 404 }
    );
  }

  let body: {
    apiKey?: string;
    apiSecret?: string;
    username?: string;
    baseUrl?: string;
    since?: string;
    until?: string;
    pageSize?: number;
    minValue?: number;
    keyword?: string;
    postcodes?: string[];
    sectors?: string[];
    regions?: string[];
    phases?: string[];
    buildingTypes?: string[];
    forms?: string[];
    constructionOnly?: boolean;
    stage?: 'planning' | 'tender' | 'award';
    businessUnits?: string[];
  } = {};
  try {
    body = await request.json();
  } catch {
    // no body — will fail the credential check below
  }

  // A source can run when the body carries a complete credential set OR when
  // one already resolves server-side (saved in /settings, or an env var).
  // Keyless sources (gov/EU open data, RSS, GEM files) always pass.
  const status = await getCredentialStatus(source);
  const needsUsername = source === 'barbour-abi';
  const bodyHasCredentials = needsUsername
    ? Boolean(body.apiKey?.trim() && body.username?.trim() && body.apiSecret?.trim())
    : Boolean(body.apiKey?.trim());

  if (!status.keyless && !status.configured && !bodyHasCredentials) {
    return NextResponse.json(
      {
        ok: false,
        errorKind: 'auth',
        message: needsUsername
          ? 'No Barbour ABI credentials found. Save a username, password and key in Settings, or paste them here for a one-off search.'
          : 'No API key found for this source. Save one in Settings, or paste a key here for a one-off search.',
      },
      { status: 200 }
    );
  }

  try {
    const raw = await adapter.fetchRawProjects({
      since: body.since ? new Date(body.since) : undefined,
      until: body.until ? new Date(body.until) : undefined,
      pageSize: body.pageSize && body.pageSize > 0 ? Math.min(body.pageSize, 200) : 50,
      minValue: body.minValue,
      keyword: body.keyword,
      postcodes: body.postcodes,
      sectors: body.sectors,
      regions: body.regions,
      forms: body.forms,
      constructionOnly: body.constructionOnly,
      stage: body.stage,
      businessUnits: body.businessUnits,
      credentials: {
        apiKey: body.apiKey,
        apiSecret: body.apiSecret,
        username: body.username,
        baseUrl: body.baseUrl,
      },
    });

    let normalized = raw
      .map((r) => {
        try {
          return adapter.normalize(r);
        } catch {
          return null;
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // Display-level filters applied uniformly after normalization (both
    // sources expose current_phase / building_type identically here).
    if (body.phases?.length) {
      const wanted = body.phases.map((p) => p.toLowerCase());
      normalized = normalized.filter((n) => wanted.some((p) => (n.current_phase ?? '').toLowerCase().includes(p)));
    }
    if (body.buildingTypes?.length) {
      const wanted = body.buildingTypes.map((b) => b.toLowerCase());
      normalized = normalized.filter((n) => wanted.some((b) => (n.building_type ?? '').toLowerCase().includes(b)));
    }

    // Attach the same classification the DB generates on ingest (ref_code,
    // org_path, vertical, contact_status) so search shows how each result
    // would be organised once persisted. Display-only — never inserted.
    //
    // Priority is scored with the SAME admin policy the materialized pass
    // uses, so the rank you see in search is the rank the record gets once
    // ingested. Key-account signals aren't known pre-ingest, so that
    // component simply scores zero here.
    const { config: scoring } = await getScoringPolicy();
    const now = Date.now();
    const results = normalized
      .map((n) => {
        const classification = classify(n);
        const priority = scorePriority(
          { ...n, vertical: classification.vertical, contact_status: classification.contact_status },
          scoring,
          now
        );
        return {
          ...n,
          ...classification,
          priority_score: priority.score,
          priority_band: priority.band,
          priority_reasons: priority.reasons,
        };
      })
      .sort((a, b) => b.priority_score - a.priority_score);

    return NextResponse.json({
      ok: true,
      count: results.length,
      rawCount: raw.length,
      credentialOrigin: bodyHasCredentials ? 'request' : status.origin,
      results,
    });
  } catch (err) {
    let errorKind: 'auth' | 'network' | 'shape' | 'unknown' = 'unknown';
    if (err instanceof AdapterAuthError) errorKind = 'auth';
    else if (err instanceof AdapterNetworkError) errorKind = 'network';
    else if (err instanceof AdapterShapeError) errorKind = 'shape';

    return NextResponse.json(
      { ok: false, errorKind, message: err instanceof Error ? err.message : String(err) },
      { status: 200 }
    );
  }
}
