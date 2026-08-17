import { redirect } from 'next/navigation';
import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { MCP_TOOLS } from '@/lib/mcp/tools';
import { checkAuthorizeRequest, CARRIED_PARAMS } from '@/lib/auth/oauth/authorize';
import { requestOrigin } from '@/lib/auth/oauth/origin';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import Logo from '@/components/shell/Logo';
import { Card, CardBody, Button } from '@/components/ui';
import { approveConnection, denyConnection } from './actions';

export const dynamic = 'force-dynamic';

/**
 * The consent screen — the only place in this whole subsystem where a decision
 * is actually made by a person.
 *
 * Everything else is mechanism. Registration hands out an identifier, the token
 * endpoint hands out credentials, and neither is a judgement about whether this
 * connection should exist. This page is that judgement, so it has to state
 * plainly what is being granted, to whom, and for how long — a consent screen
 * that says "Allow access?" and nothing more trains people to click through it,
 * which makes the whole flow decorative.
 *
 * Three things are therefore named explicitly: the client's registered name, the
 * address the code will be returned to, and — the part a generic OAuth screen
 * cannot tell you — WHICH TOOLS this person's role actually unlocks. That last one
 * matters because the honest answer is sometimes "none": every MCP tool here reads
 * across the pipeline, so a role limited to its own leads gets an empty tool list,
 * and finding that out on this screen is far better than finding out from a
 * connected assistant that claims to know nothing.
 */

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Explains itself, then stops. Used for the errors that must not be redirected. */
function Fatal({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6 py-16">
      <Logo width={148} priority />
      <h1 className="text-foreground mt-6 text-2xl font-bold">{title}</h1>
      <Card className="mt-6">
        <CardBody>
          <p className="text-body text-sm">{detail}</p>
          <p className="text-muted mt-3 text-sm">
            Nothing has been connected and nothing has been shared. You can close this tab.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

export default async function AuthorizePage({ searchParams }: Props) {
  if (!isSupabaseServerConfigured()) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <SupabaseNotConfigured detail="Connecting an assistant needs Supabase. Configure it, then try again." />
      </div>
    );
  }

  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    // A repeated parameter is a malformed request, not a list to merge — take the
    // first and let validation judge it, rather than silently concatenating.
    if (typeof value === 'string') params.set(key, value);
    else if (Array.isArray(value) && value[0]) params.set(key, value[0]);
  }

  const origin = await requestOrigin();
  const check = await checkAuthorizeRequest(params, origin);

  if (check.kind === 'fatal') return <Fatal title={check.title} detail={check.detail} />;
  if (check.kind === 'bounce') redirect(check.url);

  const request = check.request;

  /*
    Sign-in happens AFTER validation, deliberately.

    Sending somebody through Google before noticing that the link they followed is
    malformed wastes their time and, worse, makes a tampered link look like a
    normal sign-in prompt. Validate the request, then ask who is approving it.
  */
  const user = await requireUser(request.returnTo);

  const allowed = MCP_TOOLS.filter((tool) => can(user, tool.permission));
  const host = new URL(request.redirectUri).host;

  /** Every carried parameter, as hidden inputs. The action re-validates them all. */
  const hidden = CARRIED_PARAMS.map((key) => {
    const value = params.get(key);
    return value ? <input key={key} type="hidden" name={key} value={value} /> : null;
  });

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6 py-16">
      <Logo width={148} priority />
      <h1 className="text-foreground mt-6 text-2xl font-bold">Connect an assistant</h1>
      <p className="text-muted mt-1 text-sm">GTM Radar</p>

      <Card className="mt-6">
        <CardBody>
          <p className="text-body text-sm">
            <span className="text-foreground font-semibold">{request.client.clientName}</span> is asking to read this
            workspace as <span className="text-foreground font-semibold">{user.email ?? user.fullName ?? 'you'}</span>.
          </p>

          <dl className="border-border-base mt-4 space-y-2 border-t pt-4 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Reads as your role</dt>
              <dd className="text-foreground font-medium">{user.role}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Tools it will see</dt>
              <dd className="text-foreground font-medium">
                {allowed.length} of {MCP_TOOLS.length}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Returns to</dt>
              <dd className="text-foreground font-medium break-all">{host}</dd>
            </div>
          </dl>

          {/*
            The empty case is called out rather than left as a "0 of 9" somebody
            has to interpret. It is a real and confusing outcome — the connection
            succeeds and the assistant then appears to know nothing at all.
          */}
          {allowed.length === 0 ? (
            <p className="text-body mt-4 text-sm">
              <span className="text-foreground font-semibold">Your role unlocks none of the tools.</span> Every tool here
              reads across the whole pipeline, and the <span className="font-medium">{user.role}</span> role cannot. You
              can approve this, but the assistant will have nothing to answer with — ask an admin for a role with{' '}
              <span className="font-medium">View all leads</span> first.
            </p>
          ) : (
            <p className="text-muted mt-4 text-sm">
              It can read: {allowed.map((tool) => tool.name).join(', ')}.
            </p>
          )}

          <p className="text-muted mt-4 text-sm">
            <span className="text-foreground font-semibold">Reading only.</span> Nothing it can call assigns, exports,
            enriches or edits a policy. Its access follows your role, so it narrows when your role does and stops when
            your account is deactivated. You can cut it off at any time under Settings.
          </p>

          <form className="mt-6 flex gap-3">
            {hidden}
            <Button type="submit" variant="primary" formAction={approveConnection}>
              Approve
            </Button>
            {/*
              Refusal posts too, rather than being a link back or a closed tab —
              the client is told `access_denied` so it stops waiting on a
              connection that is never going to complete.
            */}
            <Button type="submit" variant="secondary" formAction={denyConnection}>
              Cancel
            </Button>
          </form>
        </CardBody>
      </Card>

      <p className="text-muted mt-4 text-xs">
        Approving issues a token to {request.client.clientName} only, for the address shown above. It expires after eight
        hours and renews itself while the connection stays in use.
      </p>
    </div>
  );
}
