import { NextRequest, NextResponse } from 'next/server';
import { processGemFiles, type GemFileInput } from '@/lib/gem/ingest';
import { saveGemFiles } from '@/lib/gem/local';
import { trackerFromFilename } from '@/lib/gem/normalize';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
// GEM trackers can be several MB — allow a long-running upsert.
export const maxDuration = 300;

/**
 * POST /api/gem/ingest
 *
 * Drag-and-drop upload endpoint for Global Energy Monitor tracker files.
 * Accepts multipart/form-data with one or more `files` (each a GEM JSON export;
 * the tracker is inferred from the filename, e.g. `solar.json` -> solar). Also
 * accepts a JSON body `{ tracker, records }` for programmatic use.
 *
 * Normalization always runs and is returned as a preview; rows persist to
 * canonical_projects only when Supabase is configured. See lib/gem/ingest.ts.
 */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('sources.ingest');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const contentType = request.headers.get('content-type') ?? '';
  let inputs: GemFileInput[] = [];

  try {
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const trackerOverride = formData.get('tracker');
      const explicit =
        typeof trackerOverride === 'string' && trackerOverride.trim()
          ? trackerFromFilename(trackerOverride)
          : undefined;
      const files = formData.getAll('files').filter((f): f is File => f instanceof File);
      if (files.length === 0) {
        return NextResponse.json(
          { ok: false, message: 'No files were uploaded (field name must be "files").' },
          { status: 400 }
        );
      }
      inputs = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          text: await f.text(),
          tracker: files.length === 1 ? explicit : undefined,
        }))
      );
    } else {
      const body = (await request.json()) as { tracker?: string; records?: unknown[]; text?: string };
      if (!body || (!Array.isArray(body.records) && typeof body.text !== 'string')) {
        return NextResponse.json(
          { ok: false, message: 'Send multipart form-data files, or JSON { tracker, records }.' },
          { status: 400 }
        );
      }
      const tracker = body.tracker ? trackerFromFilename(body.tracker) : 'gem';
      inputs = [{ name: `${tracker}.json`, text: body.text ?? JSON.stringify(body.records), tracker }];
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: `Could not read upload: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 }
    );
  }

  const result = await processGemFiles(inputs);

  // Persist the raw files into the GEM folder so they are immediately
  // searchable under "GEM Trackers" (and re-ingestable) even without a DB.
  const { saved, dir, error: saveError } = await saveGemFiles(inputs);
  const savedNote = saved.length
    ? ` Saved ${saved.length} file${saved.length === 1 ? '' : 's'} to the server folder — now searchable under GEM Trackers.`
    : '';
  const saveErrNote = saveError ? ` (Could not save to folder: ${saveError})` : '';

  return NextResponse.json({
    ...result,
    savedToFolder: saved,
    folder: dir,
    message: `${result.message}${savedNote}${saveErrNote}`,
  });
}
