import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { isCronSecret } from '@/lib/auth/cronSecret';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/apollo/phone?record=<id>&token=<secret>
 *
 * Where Apollo delivers verified phone numbers. The reveal endpoint answers
 * synchronously without the number and calls back here minutes later, so this
 * is the only place a direct dial ever arrives.
 *
 * Authenticated by a token in the query string, because Apollo sends no custom
 * headers. It reuses CRON_SECRET rather than introducing a second shared
 * secret to manage — the threat is the same (an unauthenticated writer) and so
 * is the mitigation. Without it, anyone who guessed the URL could write a
 * phone number onto any lead.
 *
 * Always answers 200 once authenticated: Apollo retries on any other status,
 * and a retry cannot fix a payload we could not use.
 */
export async function POST(request: NextRequest) {
  const url = request.nextUrl;
  const token = url.searchParams.get('token') ?? request.headers.get('x-cron-secret');
  if (!isCronSecret(token)) {
    return NextResponse.json({ ok: false, message: 'Unauthorized.' }, { status: 401 });
  }

  const recordId = url.searchParams.get('record');
  if (!recordId) return NextResponse.json({ ok: true, message: 'No record id — ignored.' });

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: true, message: 'Unparseable body — ignored.' });
  }

  const person = (payload.person ?? payload) as Record<string, unknown>;
  const numbers = Array.isArray(person.phone_numbers)
    ? (person.phone_numbers as { sanitized_number?: string; raw_number?: string; type?: string }[])
    : [];

  // A mobile is what this costs 8 credits for; prefer it over a work line.
  const best =
    numbers.find((n) => /mobile/i.test(n.type ?? '') && (n.sanitized_number || n.raw_number)) ?? numbers[0];
  const phone = best?.sanitized_number || best?.raw_number || null;

  if (!phone) return NextResponse.json({ ok: true, message: 'No number in the payload.' });
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: true, message: 'Supabase not configured — nothing stored.' });
  }

  const service = getServiceSupabase();
  const { data: row } = await service
    .from('canonical_projects')
    .select('id, contact_phone, field_provenance')
    .eq('id', recordId)
    .maybeSingle();

  if (!row) return NextResponse.json({ ok: true, message: 'Unknown record — ignored.' });

  const existing = (row as { contact_phone: string | null }).contact_phone;
  const provenance = ((row as { field_provenance: Record<string, string> | null }).field_provenance ?? {}) as Record<
    string,
    string
  >;

  // A verified direct dial outranks a switchboard we filled in as a fallback,
  // but never overwrites a number that came with the source record.
  const replaceable = !existing || provenance.contact_phone === 'apollo';
  if (!replaceable) {
    return NextResponse.json({ ok: true, message: 'Record already has a source-supplied number.' });
  }

  const { error } = await service
    .from('canonical_projects')
    .update({
      contact_phone: phone,
      field_provenance: { ...provenance, contact_phone: 'apollo' },
    })
    .eq('id', recordId);

  if (error) return NextResponse.json({ ok: true, message: `Store failed: ${error.message}` });
  return NextResponse.json({ ok: true, message: 'Phone stored.' });
}
