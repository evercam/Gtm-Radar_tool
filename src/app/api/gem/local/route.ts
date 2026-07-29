import { NextRequest, NextResponse } from 'next/server';
import { processGemFiles } from '@/lib/gem/ingest';
import { listGemDir, readGemFiles } from '@/lib/gem/local';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** GET /api/gem/local — list available GEM files in the configured folder. */
export async function GET() {
  const auth = await checkPermission('sources.ingest');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  return NextResponse.json(await listGemDir());
}

/**
 * POST /api/gem/local — ingest files from the folder.
 * Body: { files?: string[] }. Omit `files` (or send []) to ingest every JSON
 * file in the folder.
 */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('sources.ingest');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const body = (await request.json().catch(() => ({}))) as { files?: string[] };
  const requested = Array.isArray(body.files) ? body.files : undefined;

  const { inputs, dir, error } = await readGemFiles(requested);
  if (error) {
    return NextResponse.json({ ok: false, message: `${error} Set GEM_DATA_DIR in .env.local.` }, { status: 200 });
  }
  if (inputs.length === 0) {
    return NextResponse.json(
      { ok: false, dir, message: 'No matching .json files found in the GEM folder.' },
      { status: 200 }
    );
  }

  const result = await processGemFiles(inputs);
  return NextResponse.json({ ...result, dir });
}
