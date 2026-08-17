import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyToken, type TokenIdentity } from '@/lib/auth/apiTokens';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
import { verifyAccessToken } from '@/lib/auth/oauth/tokens';
import { challenge } from '@/lib/auth/oauth/metadata';
import { MCP_TOOLS, findTool, toolInputSchema, McpToolError } from '@/lib/mcp/tools';

export const dynamic = 'force-dynamic';
/** Some tools page the whole table; the default platform ceiling is too tight. */
export const maxDuration = 120;

/**
 * MCP over HTTP.
 *
 * The stdio server in scripts/ serves an agent running on someone's own machine.
 * This serves everything else — Claude Desktop, a remote agent, anything that can
 * hold a bearer token — from the deployed app, with no local checkout required.
 *
 * The tools themselves live in lib/mcp/tools.ts and are shared with the stdio
 * server, so the two transports cannot drift into answering different questions.
 *
 * THREE ways to authenticate, and they exist for three different callers:
 *
 *   1. An OAuth access token (lib/auth/oauth/*), which belongs to a PERSON and
 *      reads through their own role. This is what a hosted client such as
 *      claude.ai obtains for itself, because its connector UI has nowhere to
 *      paste a static token. Preferred for anything a colleague connects.
 *   2. A static bearer token (lib/auth/apiTokens.ts), which belongs to a ROLE.
 *      Right for a script or a cron job, which is not a person and should not
 *      borrow one's identity.
 *   3. A signed-in browser session, so the endpoint can be exercised from a
 *      logged-in tab without minting anything.
 *
 * All three converge on a resolved permission list, so everything below this
 * point is indifferent to which one arrived.
 *
 * READ ONLY, like its sibling. Every tool is a SELECT.
 *
 * Speaks plain JSON-RPC 2.0 over POST rather than the SDK's streamable-HTTP
 * transport: that transport wants a long-lived server object and its own session
 * handling, which does not survive a serverless function that may be a different
 * instance on the next request. Every MCP method used here is a single
 * request/response, so the stateless form is both sufficient and correct.
 */

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';

/**
 * Revisions this server can be spoken to in.
 *
 * All of them, in practice, because the surface used here — initialize,
 * tools/list, tools/call, ping — is unchanged across them. Listed explicitly
 * rather than echoing whatever a client claims, so an unknown future revision
 * gets our version back and a decision to make, instead of a false agreement.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

/**
 * CORS, so a browser-based MCP client can talk to this at all.
 *
 * `*` rather than a list, which is safe precisely because credentials are sent in
 * the Authorization header and never in a cookie that a wildcard origin could
 * ride on: the browser refuses to send cookies to a wildcard origin, so the
 * session-cookie path below simply does not exist cross-origin. Bearer tokens are
 * unaffected, which is what a remote client uses.
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version, Last-Event-ID',
  /*
    Without this the browser hides WWW-Authenticate from the client, and the
    client cannot find the discovery document it points at — a silent dead end.
  */
  'Access-Control-Expose-Headers': 'WWW-Authenticate, MCP-Protocol-Version',
};

const rpcResult = (id: string | number | null | undefined, result: unknown) =>
  NextResponse.json({ jsonrpc: '2.0', id: id ?? null, result }, { headers: CORS });

const rpcError = (id: string | number | null | undefined, code: number, message: string, status = 200) =>
  NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status, headers: CORS });

/**
 * A 401 that a client can act on.
 *
 * The `WWW-Authenticate` header is the entire mechanism by which an MCP client
 * discovers that OAuth is available here. Without it a client sees only that it
 * was refused, guesses that this origin is also the authorization server, and
 * probes it — which is how "couldn't register with the sign-in service" happened.
 * RFC 9728 §5.1 defines the `resource_metadata` parameter for exactly this, and
 * it is built in lib/auth/oauth/metadata.ts so the URL cannot drift from the
 * rewrite that serves it.
 */
const unauthorized = (
  request: NextRequest,
  id: string | number | null | undefined,
  message: string,
  /*
    Whether a credential was actually presented. Decides whether the challenge
    carries `error="invalid_token"` — see the comment in metadata.ts. Passing this
    through rather than inferring it from the message keeps the two from drifting
    when somebody rewords one of the messages below.
  */
  presented: boolean
) =>
  NextResponse.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message } },
    {
      status: 401,
      headers: { ...CORS, 'WWW-Authenticate': challenge(request.nextUrl.origin, presented ? message : undefined) },
    }
  );

/** Who is calling, as a permission holder. */
async function authenticate(request: NextRequest): Promise<
  { ok: true; who: string; permissions: string[] } | { ok: false; message: string; presented: boolean }
> {
  const bearer = request.headers.get('authorization');
  if (bearer) {
    /*
      OAuth first, and the order is decided by the prefix rather than by trying
      each in turn: `gtmo_` is an access token, `gtm_` is a static one. Checking
      the prefix means a revoked OAuth token is never re-tried as a static token
      and reported with the wrong reason.
    */
    const raw = bearer.replace(/^Bearer\s+/i, '').trim();

    if (raw.startsWith('gtmo_')) {
      const identity = await verifyAccessToken(bearer);
      if (!identity) {
        return {
          ok: false,
          presented: true,
          message: 'That access token is expired, revoked, or belongs to a deactivated account. Reconnect to continue.',
        };
      }
      return { ok: true, who: `${identity.clientName} as ${identity.email ?? identity.userId}`, permissions: identity.permissions };
    }

    const identity: TokenIdentity | null = await verifyToken(bearer);
    if (!identity) return { ok: false, presented: true, message: 'That token is not valid, or has been revoked.' };
    return { ok: true, who: `token:${identity.name}`, permissions: identity.permissions };
  }

  // A signed-in tab, so the endpoint is usable without minting a token first.
  const user = await getSessionUser();
  if (user?.isActive) return { ok: true, who: user.email ?? user.id, permissions: user.permissions };

  return {
    ok: false,
    presented: false,
    message: 'Authentication required: connect via OAuth, send a bearer token, or sign in.',
  };
}

export async function POST(request: NextRequest) {
  let body: RpcRequest;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, 'Parse error: body was not JSON.', 400);
  }

  const id = body.id ?? null;
  const method = body.method;
  if (!method) return rpcError(id, -32600, 'Invalid request: no method.');

  /*
    Notifications carry no id and expect no reply. `notifications/initialized`
    arrives right after the handshake, and answering it with a result is a
    protocol error on some clients.
  */
  if (method.startsWith('notifications/')) return new NextResponse(null, { status: 202, headers: CORS });

  /*
    Authentication comes BEFORE the handshake now, and that reversal is the fix.

    It used to answer `initialize` unauthenticated, on the reasoning that a client
    should be able to discover the server and then be told plainly that it needs a
    token. That reasoning was sound when a static token was the only credential —
    and it is exactly what stopped OAuth from ever starting.

    A client that gets 200 on `initialize` concludes the server needs no
    authentication at all. It proceeds to `tools/list`, gets a 401 it was not
    expecting mid-session, and reports a broken server rather than beginning an
    authorization flow. The 401 has to arrive on the FIRST request for the
    challenge header to mean anything.

    Discovery is not lost by this — it is improved. The 401 now carries
    `WWW-Authenticate: Bearer resource_metadata="…"`, which tells the client
    precisely where to go next instead of leaving it to guess.
  */
  const auth = await authenticate(request);
  if (!auth.ok) return unauthorized(request, id, auth.message, auth.presented);
  const holder = { permissions: auth.permissions };

  if (method === 'initialize') {
    /*
      The protocol version is negotiated rather than asserted. A client states
      what it speaks; if that is a revision we understand, it is echoed back, and
      otherwise it is told ours and left to decide. Every method here is a single
      request and response, so the differences between these revisions do not
      reach this server — but a client whose version is flatly contradicted may
      refuse the session, and being wrong about that is a connection failure with
      no visible cause.
    */
    const asked = (body.params?.protocolVersion as string) ?? '';
    const speaking = SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION;

    return rpcResult(id, {
      protocolVersion: speaking,
      capabilities: { tools: {} },
      serverInfo: { name: 'gtm-radar', version: '1.0.0' },
    });
  }

  if (method === 'tools/list') {
    /*
      Only the tools this caller may actually call.

      Listing everything and failing on call would be worse: an agent plans
      against the list it is given, so advertising a tool it cannot use produces
      a confident plan that dies halfway through.
    */
    const allowed = MCP_TOOLS.filter((t) => can(holder, t.permission));
    return rpcResult(id, {
      tools: allowed.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: toolInputSchema(t),
      })),
    });
  }

  if (method === 'tools/call') {
    const name = (body.params?.name as string) ?? '';
    const args = (body.params?.arguments as Record<string, unknown>) ?? {};
    const tool = findTool(name);
    if (!tool) return rpcError(id, -32602, `No tool named "${name}".`);

    if (!can(holder, tool.permission)) {
      // Structured like a tool error rather than a transport error, so an agent
      // can read the reason and choose a different tool instead of retrying.
      return rpcResult(id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { code: 'forbidden', message: `This token's role does not hold "${tool.permission}".` },
              null,
              2
            ),
          },
        ],
      });
    }

    // Validate against the same zod shape the stdio server uses, so a bad
    // argument is refused identically on both transports.
    const parsed = z.object(tool.schema).safeParse(args);
    if (!parsed.success) {
      return rpcResult(id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { code: 'invalid_arguments', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
              null,
              2
            ),
          },
        ],
      });
    }

    try {
      const result = await tool.run(parsed.data as Record<string, unknown>);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      const payload =
        err instanceof McpToolError
          ? { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }
          : { code: 'unexpected', message: err instanceof Error ? err.message : String(err) };
      return rpcResult(id, { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
    }
  }

  if (method === 'ping') return rpcResult(id, {});

  return rpcError(id, -32601, `Method "${method}" is not supported.`);
}

/**
 * GET means two different things here, and they need different answers.
 *
 * An MCP client opens GET with `Accept: text/event-stream` to subscribe to
 * server-initiated messages. This server has none — every method it supports is
 * one request and one response — and the transport spec says a server that does
 * not offer that stream must answer 405. Returning a JSON body with 200 instead,
 * which is what it did, leaves a client waiting for events on a stream that will
 * never produce any.
 *
 * A person pasting the URL into a browser wants to know what they have found, so
 * that case still gets the descriptor.
 */
export async function GET(request: NextRequest) {
  if (request.headers.get('accept')?.includes('text/event-stream')) {
    return new NextResponse('This server has no server-initiated stream; POST JSON-RPC requests instead.', {
      status: 405,
      headers: { ...CORS, Allow: 'POST' },
    });
  }

  const origin = request.nextUrl.origin;
  return NextResponse.json(
    {
      name: 'gtm-radar',
      transport: 'JSON-RPC 2.0 over POST',
      protocolVersion: PROTOCOL_VERSION,
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      readOnly: true,
      tools: MCP_TOOLS.map((t) => t.name),
      auth: {
        /*
          Listed in the order somebody should reach for them, with the discovery
          URL spelled out. A person who lands on this JSON is usually here because
          a connector failed, and the next thing they need is the document their
          client could not find.
        */
        oauth: `${origin}/.well-known/oauth-protected-resource/api/mcp`,
        bearer: 'Authorization: Bearer gtm_… (a static token from Settings)',
        session: 'A signed-in browser session, for poking at it from a logged-in tab.',
      },
    },
    { headers: CORS }
  );
}

/**
 * Pre-flight. Required rather than optional: a browser-based MCP client sends
 * `Authorization`, which is not a CORS-safelisted header, so every one of its
 * requests is preceded by this. Answering it wrongly makes the endpoint appear
 * unreachable from a browser while working perfectly from curl.
 */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
}
