import { NextResponse, type NextRequest } from 'next/server';
import { checkPermission } from '@/lib/auth/session';
import { readSecret } from '@/lib/crypto/store';

export const dynamic = 'force-dynamic';

/**
 * POST /api/sources/collect — starts a browser-based collector.
 *
 * Some sources have no API this app can call, only a web application behind a
 * login. Reading those needs a real browser, and a browser cannot run here:
 * Chromium is around 300 MB against a 250 MB function limit. So the work lives
 * in GitHub Actions and this route starts it.
 *
 * That keeps one button in one place. The alternative — telling an operator to
 * open GitHub, find the workflow and fill in the inputs — is the same work
 * done less reliably, and it puts the collector somewhere nobody looks.
 */

/** Collectors that exist, and the workflow file each one runs. */
const COLLECTORS: Record<string, { workflow: string; label: string }> = {
  'construct-connect': { workflow: 'construct-connect.yml', label: 'ConstructConnect' },
};

/**
 * Which repository holds the collector workflows.
 *
 * Configurable because it is the one thing here that a repository rename
 * invalidates, and it invalidates it silently: GitHub redirects browser and git
 * traffic after a rename, but a REST dispatch to the old path 404s. Hardcoding
 * the slug meant a rename could only be completed by editing this file and
 * shipping a deploy, with the Collect button broken in between.
 *
 * `GITHUB_REPO` is not a secret — a repository slug is public — so it stays an
 * environment variable rather than joining the encrypted store, alongside the
 * other non-secret endpoint overrides.
 */
const REPO = process.env.GITHUB_REPO?.trim() || 'evercam/Evercam_Raddar';
const BRANCH = process.env.GITHUB_REPO_BRANCH?.trim() || 'main';

export async function POST(request: NextRequest) {
  const auth = await checkPermission('sources.run');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  let body: { slug?: string; details?: number; dryRun?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: 'Body must be JSON.' }, { status: 400 });
  }

  const collector = COLLECTORS[body.slug ?? ''];
  if (!collector) {
    return NextResponse.json(
      { ok: false, message: `No collector for "${body.slug}". Available: ${Object.keys(COLLECTORS).join(', ')}.` },
      { status: 400 }
    );
  }

  const token = await readSecret('github_token');
  if (!token) {
    return NextResponse.json({
      ok: false,
      message:
        'No GitHub token saved. Add one in Settings — fine-grained, this repository only, with Actions read and write.',
    });
  }

  // Bounded here rather than trusted from the browser: each project is a page
  // load, so an unbounded value is a run that never finishes.
  const details = Math.max(0, Math.min(500, Math.round(body.details ?? 60)));

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${collector.workflow}/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: BRANCH,
        // Workflow inputs are strings, whatever the declared type says.
        inputs: { details: String(details), dryRun: body.dryRun ? 'true' : 'false' },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json({ ok: false, message: 'Could not reach GitHub.' });
  }

  // A dispatch returns 204 and no body — there is no run id to report, which
  // is why the response points at the Actions page instead of a run.
  if (res.status === 204) {
    return NextResponse.json({
      ok: true,
      message: `${collector.label} collector started${body.dryRun ? ' (dry run — nothing will be saved)' : ''}. It takes a few minutes.`,
      runsUrl: `https://github.com/${REPO}/actions/workflows/${collector.workflow}`,
    });
  }

  const detail = await res.text().catch(() => '');
  const message =
    res.status === 401 || res.status === 403
      ? 'GitHub rejected the token. It needs Actions: read and write on this repository.'
      : res.status === 404
        ? `GitHub could not find ${collector.workflow} on ${BRANCH}. Has it been pushed?`
        : `GitHub returned ${res.status}. ${detail.slice(0, 160)}`;

  return NextResponse.json({ ok: false, message });
}
