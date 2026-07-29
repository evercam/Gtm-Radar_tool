import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { checkPermission } from '@/lib/auth/session';
import { transitionLead } from '@/lib/lifecycleStore';
import { saveEnrichmentRules } from '@/lib/enrich/rulesStore';

export const dynamic = 'force-dynamic';

/**
 * POST /api/queue — per-record queue actions and rule management.
 *
 * Snoozing defers a record without disqualifying it: it stays eligible and
 * simply isn't considered until the date passes. Forcing pushes one record
 * into the queue outside the rules, for the case where an operator knows
 * something the rules don't.
 */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('enrichment.run');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  let body: { action?: string; id?: string; days?: number; reason?: string; rules?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON.' }, { status: 400 });
  }

  if (body.action === 'saveRules') {
    const admin = await checkPermission('settings.manage');
    if (!admin.ok) return NextResponse.json({ ok: false, message: admin.message }, { status: admin.status });
    return NextResponse.json(await saveEnrichmentRules(body.rules), { status: 200 });
  }

  if (!body.id) return NextResponse.json({ ok: false, message: 'A record id is required.' }, { status: 400 });
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: false, message: 'Supabase service key not configured.' }, { status: 200 });
  }

  const service = getServiceSupabase();

  switch (body.action) {
    case 'snooze': {
      const days = Math.max(1, Math.min(365, body.days ?? 1));
      const until = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
      const { error } = await service
        .from('canonical_projects')
        .update({ snoozed_until: until, snooze_reason: body.reason ?? null, force_enrich: false })
        .eq('id', body.id);
      if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 200 });
      return NextResponse.json({ ok: true, message: `Snoozed until ${until}.` });
    }

    case 'unsnooze': {
      const { error } = await service
        .from('canonical_projects')
        .update({ snoozed_until: null, snooze_reason: null })
        .eq('id', body.id);
      if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 200 });
      return NextResponse.json({ ok: true, message: 'Snooze cleared.' });
    }

    case 'force': {
      // Clearing any snooze at the same time — forcing a record that is also
      // snoozed would otherwise be silently ignored by the next pass.
      const res = await transitionLead(body.id, 'PENDING_ENRICHMENT', {
        actor: auth.user.id,
        reason: body.reason ?? 'Forced into the queue by an operator',
        patch: { force_enrich: true, snoozed_until: null, selected_by_rule: 'manual_force' },
      });
      return NextResponse.json({ ok: res.ok, message: res.ok ? 'Queued for enrichment.' : res.message });
    }

    case 'dequeue': {
      const res = await transitionLead(body.id, 'RAW', {
        actor: auth.user.id,
        reason: body.reason ?? 'Removed from the queue',
        patch: { force_enrich: false, selected_by_rule: null },
      });
      return NextResponse.json({ ok: res.ok, message: res.ok ? 'Removed from the queue.' : res.message });
    }

    case 'disqualify': {
      const res = await transitionLead(body.id, 'LOST', {
        actor: auth.user.id,
        reason: body.reason ?? 'Disqualified',
      });
      return NextResponse.json({ ok: res.ok, message: res.ok ? 'Marked lost.' : res.message });
    }

    default:
      return NextResponse.json({ ok: false, message: `Unknown action "${body.action}".` }, { status: 400 });
  }
}
