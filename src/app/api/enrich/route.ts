import { NextRequest, NextResponse } from 'next/server';
import type { EnrichInput, EnrichResult } from '@/lib/enrich/types';
import { runEnrichment } from '@/lib/enrich/run';
import { getEnrichmentPolicy } from '@/lib/policies';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
// Enrichment can take a while (web search + a second API call) — allow headroom.
export const maxDuration = 120;

/**
 * POST /api/enrich
 *
 * Enrich ONE record: Claude identifies the account + mines news, Apollo adds
 * verified contacts, GLEIF adds corporate hierarchy. When the body carries a
 * canonical_projects id the result is written back with per-field provenance;
 * otherwise it is returned inline only.
 *
 * The work itself lives in lib/enrich/run so /api/enrich/batch can drive the
 * same path without an HTTP hop. Which engines run comes from the admin
 * enrichment policy — see /settings.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Every other enrichment route gates on this; this one did not, so a single
  // record could be enriched — spending Apollo credits and writing back to
  // canonical_projects — by anyone who could reach the URL.
  const auth = await checkPermission('enrichment.run');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  let input: EnrichInput;
  try {
    input = (await request.json()) as EnrichInput;
  } catch {
    return NextResponse.json(
      {
        ok: false,
        account: null,
        contacts: [],
        news: [],
        reasoning: null,
        confidence: null,
        engines: { claude: false, apollo: false },
        message: 'Invalid request body.',
      } satisfies EnrichResult,
      { status: 400 }
    );
  }

  const { config: policy } = await getEnrichmentPolicy();
  const result = await runEnrichment(input, policy);
  // Failures are reported in the payload rather than the status code — the
  // panel renders the message inline either way.
  return NextResponse.json(result, { status: 200 });
}
