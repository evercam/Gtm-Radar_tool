'use server';

import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import { checkAuthorizeRequest, bounceUrl, CARRIED_PARAMS } from '@/lib/auth/oauth/authorize';
import { mintCode } from '@/lib/auth/oauth/codes';
import { requestOrigin } from '@/lib/auth/oauth/origin';

/**
 * Approving or refusing a connection.
 *
 * A Server Action is a public endpoint — anybody who can invoke it can post
 * whatever fields they like — so NOTHING the consent page rendered is trusted
 * here. Every parameter is re-validated through the same
 * `checkAuthorizeRequest` the page used, and the identity is re-read from the
 * session cookie rather than carried in a hidden field. A user id in a form
 * input would be an invitation to mint somebody else's authorization code.
 *
 * Cross-site invocation is handled by the framework rather than by a nonce of our
 * own: Next.js verifies Origin against Host for every Server Action, and the
 * session cookie is SameSite=Lax so it is withheld from a cross-site POST anyway.
 * Two independent reasons a form on another site cannot approve anything.
 */

/** Rebuilds the request parameters from the submitted form. */
function submitted(formData: FormData): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of CARRIED_PARAMS) {
    const value = formData.get(key);
    if (typeof value === 'string' && value) params.set(key, value);
  }
  return params;
}

export async function approveConnection(formData: FormData): Promise<void> {
  const origin = await requestOrigin();
  const params = submitted(formData);

  const check = await checkAuthorizeRequest(params, origin);
  /*
    A fatal outcome cannot be reported to the client — by definition there is no
    verified address to report it to — so it goes back to the consent page, which
    re-runs the same check and renders the explanation. Redirecting to a URI that
    failed validation is the mistake this branch exists to avoid.
  */
  if (check.kind === 'fatal') redirect(`/oauth/authorize?${params.toString()}`);
  if (check.kind === 'bounce') redirect(check.url);

  const request = check.request;

  /*
    The identity, read fresh. Between rendering the page and this submission the
    session could have expired or the account could have been deactivated, and an
    approval is exactly the wrong thing to grant on a stale one.
  */
  const user = await getSessionUser();
  if (!user || !user.isActive) redirect(`/signin?next=${encodeURIComponent(request.returnTo)}`);

  const code = await mintCode({
    clientId: request.client.clientId,
    userId: user.id,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scope: request.scope,
    resource: request.resource,
  });

  if (!code) {
    redirect(
      bounceUrl(
        request.redirectUri,
        'server_error',
        'Could not record the approval. The MCP OAuth migration may not have been applied yet.',
        request.state,
        origin
      )
    );
  }

  const url = new URL(request.redirectUri);
  url.searchParams.set('code', code);
  // `state` is echoed back untouched — it is the client's CSRF defence, and
  // dropping it makes a conformant client refuse the response.
  if (request.state) url.searchParams.set('state', request.state);
  // RFC 9207, matching what the metadata advertises.
  url.searchParams.set('iss', origin);

  redirect(url.toString());
}

export async function denyConnection(formData: FormData): Promise<void> {
  const origin = await requestOrigin();
  const params = submitted(formData);

  const check = await checkAuthorizeRequest(params, origin);
  if (check.kind === 'fatal') redirect(`/oauth/authorize?${params.toString()}`);
  if (check.kind === 'bounce') redirect(check.url);

  /*
    A refusal is reported to the client, not swallowed. `access_denied` is what
    tells a connector to stop waiting and say so, instead of sitting on a pending
    connection that will never complete.
  */
  redirect(
    bounceUrl(
      check.request.redirectUri,
      'access_denied',
      'The request was declined on the consent screen.',
      check.request.state,
      origin
    )
  );
}
