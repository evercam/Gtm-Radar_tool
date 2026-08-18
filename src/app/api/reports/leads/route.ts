import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { checkPermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getAssignableUsers } from '@/lib/assignmentStore';
import { fetchReportRows, buildSummary, REPORT_ROW_CAP } from '@/lib/reports/leadReport';
import { logEvent } from '@/lib/observability/events';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * A person's leads as an .xlsx download.
 *
 *   GET /api/reports/leads?assignee=<rosterId>&from=2026-08-10&to=2026-08-10
 *   GET /api/reports/leads?assignee=<rosterId>&from=2026-08-01&to=2026-08-31&exported=1
 *
 * Built because the question "what went to this person on that day" was answered
 * once with a throwaway script, and it is obviously going to be asked again about
 * somebody else. The data lives in 133 columns, so answering it without a tool
 * means writing SQL, and the person who wants the answer is not the person who
 * writes SQL.
 *
 * Read-only. Nothing here re-exports or re-assigns anything.
 */
export async function GET(request: Request) {
  /*
    Baseline is leads.view.own, which every seller holds. Reaching somebody else's
    book needs leads.view.all, checked below — a download must not be a way around
    the permission that governs the same data on screen.
  */
  const auth = await checkPermission('leads.view.own');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });
  const user = auth.user;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: false, message: 'Supabase is not configured.' }, { status: 503 });
  }

  const url = new URL(request.url);
  const assigneeId = url.searchParams.get('assignee') ?? undefined;
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const exportedOnly = url.searchParams.get('exported') === '1';

  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  for (const [name, value] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (value && !DAY.test(value)) {
      return NextResponse.json({ ok: false, message: `\`${name}\` must be YYYY-MM-DD.` }, { status: 400 });
    }
  }

  /*
    A spreadsheet of leads carries contact details out of the app, so who may take
    one is narrower than who may look at a page.

    Anybody may download their OWN book. Downloading somebody else's needs
    leads.view.all, which is the same permission that lets you see their leads on
    screen — this must not become a way around that.
  */
  const { users: roster, unavailable: rosterUnavailable } = await getAssignableUsers();
  /*
    Checked BEFORE the not-found below, because an unreadable roster would otherwise
    answer "No active roster member with that id" — a confident 404 about a person
    who may well exist.
  */
  if (rosterUnavailable) {
    return NextResponse.json(
      { ok: false, message: `The roster could not be read (${rosterUnavailable}). Retry — this is not a missing person.` },
      { status: 503 }
    );
  }
  const target = assigneeId ? roster.find((r) => r.id === assigneeId) : null;
  if (assigneeId && !target) {
    return NextResponse.json({ ok: false, message: 'No active roster member with that id.' }, { status: 404 });
  }

  const isSelf = Boolean(target?.userId && target.userId === user.id);
  if (!isSelf && !can(user, 'leads.view.all')) {
    return NextResponse.json(
      { ok: false, message: 'Your role only allows downloading your own leads.' },
      { status: 403 }
    );
  }

  const startedAt = Date.now();
  let result;
  try {
    result = await fetchReportRows({ assigneeId, from, to, exportedOnly });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent({
      kind: 'export',
      name: 'report.leads',
      ok: false,
      durationMs: Date.now() - startedAt,
      actor: user.email,
      detail: { assignee: target?.name, from, to, exportedOnly, error: message },
    });
    return NextResponse.json({ ok: false, message: `Could not build the report: ${message}` }, { status: 200 });
  }

  const { rows, truncated } = result;
  const owner = target?.name ?? 'All owners';

  const wb = XLSX.utils.book_new();

  const summary = XLSX.utils.aoa_to_sheet(buildSummary(rows, { owner, from, to, truncated }));
  summary['!cols'] = [{ wch: 30 }, { wch: 64 }];
  XLSX.utils.book_append_sheet(wb, summary, 'Summary');

  /*
    An empty result still gets a workbook rather than a 404. "Nobody was given
    anything that day" is a legitimate answer and the Summary sheet states it;
    returning an error would make a real answer look like a broken feature.
  */
  const leads = XLSX.utils.json_to_sheet(rows);
  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    leads['!cols'] = headers.map((h) =>
      /hook|angle|pain|^Project$|URL|Trigger/i.test(h)
        ? { wch: 46 }
        : /Email|Company|Contact|Title|Apollo/i.test(h)
          ? { wch: 28 }
          : { wch: 14 }
    );
    // Frozen header and a filter row, because the first thing anybody does with
    // this is sort it.
    leads['!freeze'] = { xSplit: 1, ySplit: 1 };
    leads['!autofilter'] = {
      ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: headers.length - 1, r: rows.length } }),
    };
  }
  XLSX.utils.book_append_sheet(wb, leads, 'Leads');

  /*
    Written to a buffer rather than to disk: this runs on a serverless instance
    with no writable filesystem worth using, and the response is the artefact.
  */
  const body = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  const slug = owner.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'leads';
  const span = from && to ? (from === to ? from : `${from}_${to}`) : (from ?? to ?? 'all-dates');
  const filename = `${slug}-leads-${span}.xlsx`;

  await logEvent({
    kind: 'export',
    name: 'report.leads',
    // `ok` is about completeness, not "did it respond" — a capped sheet is a
    // partial answer and should not read as a finished one in the log.
    ok: !truncated,
    durationMs: Date.now() - startedAt,
    actor: user.email,
    detail: { assignee: owner, from, to, exportedOnly, rows: rows.length, truncated, cap: REPORT_ROW_CAP },
  });

  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // A report is a snapshot of a moving table; a cached one is a wrong one.
      'Cache-Control': 'no-store',
    },
  });
}
