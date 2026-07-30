import { NextResponse, type NextRequest } from 'next/server';
import { isCronRequest } from '@/lib/auth/cronSecret';
import { checkPermission } from '@/lib/auth/session';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { constructConnectAdapter } from '@/lib/adapters/construct-connect';
import type { RawProjectRecord } from '@/lib/adapters/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/ingest/construct-connect/push
 *
 * Accepts ConstructConnect project documents collected elsewhere and puts them
 * through the same pipeline the API adapter uses.
 *
 * This exists because the ProjectLeads API is a paid add-on. The web app the
 * account already pays for returns the same projects, but reaching it needs a
 * real browser session — and a browser cannot run in this app: Chromium is
 * ~300 MB against Vercel's 250 MB function limit. So collection happens
 * outside (see .github/workflows/construct-connect.yml) and the result is
 * posted here.
 *
 * The body is deliberately the vendor's OWN shape, not a cleaned-up one. That
 * way `constructConnectAdapter.normalize` — verified against a real API
 * response — is the single mapper for both routes, and switching to the paid
 * API later changes nothing downstream.
 *
 * Authenticated as machinery (CRON_SECRET) or by a human with sources.run.
 */
export async function POST(request: NextRequest) {
  const machine = await isCronRequest();
  if (!machine) {
    const auth = await checkPermission('sources.run');
    if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });
  }

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: false, message: 'Supabase service role is not configured.' }, { status: 200 });
  }

  let body: { docs?: unknown; dryRun?: boolean; query?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Body must be JSON.' }, { status: 400 });
  }

  if (!Array.isArray(body.docs)) {
    return NextResponse.json(
      { ok: false, message: 'Expected { docs: [...] } — the vendor documents, unmodified.' },
      { status: 400 }
    );
  }
  if (body.docs.length === 0) {
    return NextResponse.json({ ok: true, message: 'Nothing to ingest — the collector sent no documents.', inserted: 0 });
  }
  // A runaway scraper posting its whole database in one request would time out
  // mid-upsert and leave the run unrecorded. Paginate instead.
  if (body.docs.length > 1000) {
    return NextResponse.json(
      { ok: false, message: `${body.docs.length} documents in one request — send at most 1000 per call.` },
      { status: 400 }
    );
  }

  const started = Date.now();
  const skipped: string[] = [];
  const normalized = [];

  for (const doc of body.docs as RawProjectRecord[]) {
    try {
      const row = constructConnectAdapter.normalize(doc);
      // Without a stable vendor id the upsert cannot dedupe, so every run would
      // insert the project again. Better to name it and move on.
      if (!row.source_unique_id) {
        skipped.push(String((doc as Record<string, unknown>).title ?? 'untitled'));
        continue;
      }
      normalized.push(row);
    } catch (e) {
      skipped.push(
        `${String((doc as Record<string, unknown>).title ?? 'untitled')}: ${e instanceof Error ? e.message : 'unmappable'}`
      );
    }
  }

  if (normalized.length === 0) {
    return NextResponse.json({
      ok: false,
      message: `None of the ${body.docs.length} documents could be mapped. The collector's shape has probably drifted.`,
      skipped: skipped.slice(0, 10),
    });
  }

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      message: `${normalized.length} of ${body.docs.length} document(s) map cleanly. Nothing was written.`,
      skippedCount: skipped.length,
      skipped: skipped.slice(0, 10),
      preview: normalized.slice(0, 3).map((r) => ({
        name: r.canonical_name,
        value: r.estimated_value,
        status: r.current_phase,
        country: r.country,
      })),
    });
  }

  const service = getServiceSupabase();

  // Counted before the upsert so the response can say inserted vs updated —
  // Postgres reports neither for an ON CONFLICT upsert.
  const ids = normalized.map((r) => r.source_unique_id as string);
  const { data: existing } = await service
    .from('canonical_projects')
    .select('source_unique_id')
    .eq('source_key', 'construct_connect')
    .in('source_unique_id', ids);
  const alreadyHere = new Set(
    ((existing ?? []) as { source_unique_id: string }[]).map((r) => r.source_unique_id)
  );

  const { error } = await service
    .from('canonical_projects')
    .upsert(normalized, { onConflict: 'source_key,source_unique_id' });

  if (error) {
    const hint = /does not exist|schema cache/i.test(error.message) ? ' Run the migrations first.' : '';
    return NextResponse.json({ ok: false, message: `${error.message}.${hint}` }, { status: 200 });
  }

  const updated = normalized.filter((r) => alreadyHere.has(r.source_unique_id as string)).length;
  const inserted = normalized.length - updated;

  // Recorded like any other ingest so the Source Hub shows it alongside the
  // scheduled runs rather than the pushed data appearing from nowhere.
  const { error: runError } = await service.from('ingestion_runs').insert({
    slug: 'construct-connect',
    source_key: 'construct_connect',
    trigger: machine ? 'cron' : 'manual',
    params: { via: 'push', query: body.query ?? null },
    // 'completed', not 'succeeded': the column has a CHECK constraint and the
    // wrong value silently records nothing, so the data lands but the Source
    // Hub shows no sign of it.
    status: 'completed',
    fetched: body.docs.length,
    normalized: normalized.length,
    inserted,
    updated,
    failed: skipped.length,
    started_at: new Date(started).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
  });

  return NextResponse.json({
    ok: true,
    // The records are already saved, so a failed run record is a reporting
    // problem, not an ingest failure — say so rather than implying data loss.
    message:
      `${inserted} new, ${updated} updated${skipped.length ? `, ${skipped.length} skipped` : ''}.` +
      (runError ? ` (Saved, but the run could not be logged: ${runError.message})` : ''),
    inserted,
    updated,
    skippedCount: skipped.length,
    skipped: skipped.slice(0, 10),
  });
}
