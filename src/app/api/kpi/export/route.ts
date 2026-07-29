import { NextRequest, NextResponse } from 'next/server';
import { checkPermission } from '@/lib/auth/session';
import { getKpiSummary, kpiToCsv } from '@/lib/kpi';

export const dynamic = 'force-dynamic';

/** GET /api/kpi/export?days=30 — the KPI summary as a CSV download. */
export async function GET(request: NextRequest) {
  const auth = await checkPermission('kpi.view');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const raw = Number(request.nextUrl.searchParams.get('days'));
  const days = [7, 30, 90].includes(raw) ? raw : 30;

  const summary = await getKpiSummary({ days });
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(kpiToCsv(summary), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="kpi-${days}d-${stamp}.csv"`,
    },
  });
}
