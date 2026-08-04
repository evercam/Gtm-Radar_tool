import { NextRequest, NextResponse } from 'next/server';
import { checkPermission } from '@/lib/auth/session';
import { notifyExportFinished } from '@/lib/notify/cliq';

export const dynamic = 'force-dynamic';

/**
 * POST /api/notify/test
 *
 * Sends one clearly-marked test message to the Zoho Cliq webhook, so Settings can
 * answer "does this URL work" without anyone running a script.
 *
 * A wrong URL is accepted by our code and rejected by Cliq, and a real export
 * cannot tell you which: the notice fires after the send is already durable, so by
 * then it is too late to be a question. Testing here is the only point at which
 * the answer changes what you do next.
 *
 * `url` is optional. Passing it tests a value that has not been saved yet —
 * otherwise pasting, saving, discovering it is wrong and clearing it again is
 * three round trips to learn one fact. Nothing is stored either way.
 */
export async function POST(request: NextRequest) {
  // Same permission that can read and write the secret itself. The route posts to
  // a caller-supplied URL, so it must not be reachable by anyone who could not
  // already set that URL.
  const auth = await checkPermission('settings.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  let body: { url?: string } = {};
  try {
    body = await request.json();
  } catch {
    // no body — test the stored secret
  }

  /**
   * A sample with something in every optional line, because the point of a test
   * is to see the shape a real notice takes — including the parts that only
   * appear on a bad day.
   */
  const result = await notifyExportFinished(
    {
      requested: 12,
      created: 10,
      existing: 2,
      failed: 0,
      perAssignee: [
        { name: 'Anas Filali', count: 8 },
        { name: 'Ronniel Manalo', count: 4 },
      ],
      atQuota: ['Ronniel Manalo'],
      flagged: 1,
      ownerOrListFailed: 0,
      trigger: 'manual',
      assignee: null,
      durationMs: 8379,
    },
    { url: body.url ?? null, prefix: '🧪 *TEST from the LDR tool* — not a real export.' }
  );

  if (result.sent) {
    return NextResponse.json({
      ok: true,
      message: `Test message sent${body.url?.trim() ? ' to the URL you pasted' : ' using the saved webhook'}. Check the Cliq chat — then Save if you have not already.`,
    });
  }

  // Each reason gets the fix, not just the label. "rejected" alone sends someone
  // back to Zoho with nothing to look for.
  const explain: Record<string, string> = {
    'not-configured': 'No webhook saved yet. Paste the URL in the box first, then press Test.',
    'unreachable-url':
      'That URL can never deliver — it must be https, and not localhost or a private network address.',
    rejected:
      'Cliq rejected it. 401 or 403 means the zapikey is wrong or missing; 404 means the channel or bot name in the URL is.',
    error: 'Could not reach Cliq at all — check the host in the URL.',
  };

  return NextResponse.json({
    ok: false,
    message: `${explain[result.reason] ?? 'Test failed.'}${result.detail ? ` (${result.detail})` : ''}`,
    reason: result.reason,
  });
}
