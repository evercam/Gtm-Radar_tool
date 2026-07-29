import { NextRequest, NextResponse } from 'next/server';
import { checkPermission } from '@/lib/auth/session';
import { saveSourceConfig, type IngestMode, type DedupeStrategy } from '@/lib/sources/config';
import { isValidCron, describeCron } from '@/lib/cron';

export const dynamic = 'force-dynamic';

const MODES: IngestMode[] = ['cron', 'manual', 'realtime'];
const STRATEGIES: DedupeStrategy[] = ['source_id', 'name_location', 'domain', 'email'];

/** PATCH /api/sources/config — update one adapter's ingestion settings. */
export async function PATCH(request: NextRequest) {
  const auth = await checkPermission('sources.ingest');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  let body: {
    slug?: string;
    isEnabled?: boolean;
    ingestMode?: string;
    scheduleCron?: string;
    monthlyRequestCap?: number | null;
    pageSize?: number;
    maxRecordsPerRun?: number;
    timeoutMs?: number;
    dedupeStrategy?: string;
    queryParams?: Record<string, unknown>;
    enrichClaude?: boolean | null;
    enrichApollo?: boolean | null;
    enrichFillCommittee?: boolean | null;
    maxApolloCallsPerRecord?: number | null;
    maxClaudeCallsPerRecord?: number | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON.' }, { status: 400 });
  }

  if (!body.slug) return NextResponse.json({ ok: false, message: 'A source slug is required.' }, { status: 400 });
  if (body.ingestMode !== undefined && !MODES.includes(body.ingestMode as IngestMode)) {
    return NextResponse.json({ ok: false, message: `Mode must be one of: ${MODES.join(', ')}.` }, { status: 400 });
  }
  if (body.dedupeStrategy !== undefined && !STRATEGIES.includes(body.dedupeStrategy as DedupeStrategy)) {
    return NextResponse.json(
      { ok: false, message: `Dedupe strategy must be one of: ${STRATEGIES.join(', ')}.` },
      { status: 400 }
    );
  }
  // The scheduler only understands the subset the picker emits; reject
  // anything else here rather than letting a malformed schedule silently never
  // fire — which is indistinguishable from a broken source.
  if (body.scheduleCron && !isValidCron(body.scheduleCron)) {
    return NextResponse.json(
      { ok: false, message: 'Schedule must be a 5-field cron expression, e.g. "0 4 * * *".' },
      { status: 400 }
    );
  }

  const res = await saveSourceConfig(body.slug, {
    isEnabled: body.isEnabled,
    ingestMode: body.ingestMode as IngestMode | undefined,
    scheduleCron: body.scheduleCron,
    monthlyRequestCap: body.monthlyRequestCap,
    pageSize: body.pageSize,
    maxRecordsPerRun: body.maxRecordsPerRun,
    timeoutMs: body.timeoutMs,
    dedupeStrategy: body.dedupeStrategy as DedupeStrategy | undefined,
    queryParams: body.queryParams,
    enrichClaude: body.enrichClaude,
    enrichApollo: body.enrichApollo,
    enrichFillCommittee: body.enrichFillCommittee,
    maxApolloCallsPerRecord: body.maxApolloCallsPerRecord,
    maxClaudeCallsPerRecord: body.maxClaudeCallsPerRecord,
  });

  // A saved query is the whole point of the hub — say so, rather than the
  // generic "configuration saved".
  if (res.ok && body.queryParams) {
    const n = Object.keys(body.queryParams).length;
    return NextResponse.json({
      ok: true,
      message: `Saved — scheduled ingests will run with ${n} filter${n === 1 ? '' : 's'}.`,
    });
  }
  // Say what was actually scheduled, in words — the whole point of the picker
  // is that nobody has to read the expression back to be sure.
  if (res.ok && body.scheduleCron !== undefined) {
    const enabled = body.ingestMode === undefined || body.ingestMode === 'cron';
    return NextResponse.json({
      ok: true,
      message: enabled
        ? `Scheduled — ingests ${describeCron(body.scheduleCron)}.`
        : 'Saved. Set the mode to Cron for this schedule to run.',
    });
  }
  return NextResponse.json(res, { status: 200 });
}
