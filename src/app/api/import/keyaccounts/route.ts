import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { normalizeKeyAccountCsv } from '@/lib/import/keyaccounts';
import type { CanonicalProjectInsert } from '@/lib/adapters/types';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const CHUNK = 500;

interface FileResult {
  file: string;
  parsed: number;
  normalized: number;
  failed: number;
  inserted?: number;
  updated?: number;
  error?: string;
}

/**
 * POST /api/import/keyaccounts
 *
 * Import key-account rows from CSV (Excel → Save As CSV). Accepts multipart
 * form-data `files`, or JSON `{ csv }`. Each row becomes an `account` record in
 * canonical_projects, ready to enrich. Persists when Supabase is configured;
 * otherwise returns a normalized preview.
 */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('sources.ingest');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const contentType = request.headers.get('content-type') ?? '';
  let files: { name: string; text: string }[] = [];

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const uploaded = form.getAll('files').filter((f): f is File => f instanceof File);
      if (uploaded.length === 0) {
        return NextResponse.json({ ok: false, message: 'No files uploaded (field "files").' }, { status: 400 });
      }
      files = await Promise.all(uploaded.map(async (f) => ({ name: f.name, text: await f.text() })));
    } else {
      const body = (await request.json()) as { csv?: string; name?: string };
      if (!body?.csv)
        return NextResponse.json({ ok: false, message: 'Send CSV files, or JSON { csv }.' }, { status: 400 });
      files = [{ name: body.name ?? 'import.csv', text: body.csv }];
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: `Could not read upload: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 }
    );
  }

  const dbReady = isSupabaseServiceConfigured();
  const supabase = dbReady ? getServiceSupabase() : null;
  const results: FileResult[] = [];
  const sample: CanonicalProjectInsert[] = [];
  let totalNormalized = 0;
  let totalInserted = 0;
  let totalUpdated = 0;

  for (const file of files) {
    const r: FileResult = { file: file.name, parsed: 0, normalized: 0, failed: 0 };
    try {
      const { records, parsed, failed } = normalizeKeyAccountCsv(file.text);
      r.parsed = parsed;
      r.normalized = records.length;
      r.failed = failed;
      totalNormalized += records.length;
      if (sample.length < 5) sample.push(...records.slice(0, 5 - sample.length));

      if (supabase && records.length > 0) {
        for (let i = 0; i < records.length; i += CHUNK) {
          const chunk = records.slice(i, i + CHUNK);
          const ids = chunk.map((c) => c.source_unique_id);
          const { data: existing } = await supabase
            .from('canonical_projects')
            .select('source_unique_id')
            .eq('source_key', chunk[0].source_key)
            .in('source_unique_id', ids);
          const seen = new Set((existing ?? []).map((e: { source_unique_id: string }) => e.source_unique_id));
          const ins = chunk.filter((c) => !seen.has(c.source_unique_id)).length;
          totalInserted += ins;
          totalUpdated += chunk.length - ins;
          const { error } = await supabase
            .from('canonical_projects')
            .upsert(chunk, { onConflict: 'source_key,source_unique_id' });
          if (error) throw new Error(error.message);
        }
        r.inserted = 0;
        r.updated = 0;
      }
    } catch (err) {
      r.error = err instanceof Error ? err.message : String(err);
    }
    results.push(r);
  }

  return NextResponse.json({
    ok: true,
    persisted: dbReady,
    message: dbReady
      ? `Imported ${totalInserted} new + ${totalUpdated} updated key-account records. Enrich them from Search or the record view.`
      : `Parsed ${totalNormalized} key-account records. Configure Supabase to save them.`,
    totals: { normalized: totalNormalized, inserted: totalInserted, updated: totalUpdated },
    files: results,
    sample,
  });
}
