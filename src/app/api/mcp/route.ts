import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyToken, type TokenIdentity } from '@/lib/auth/apiTokens';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/roles';
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
 * Authentication is a bearer token (see lib/auth/apiTokens.ts), which resolves to
 * a ROLE and therefore to the same permission matrix the UI uses. A signed-in
 * browser session is also accepted, so the endpoint can be exercised from a
 * logged-in tab without minting a token first.
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

const rpcResult = (id: string | number | null | undefined, result: unknown) =>
  NextResponse.json({ jsonrpc: '2.0', id: id ?? null, result });

const rpcError = (id: string | number | null | undefined, code: number, message: string, status = 200) =>
  NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });

/** Who is calling, as a permission holder. */
async function authenticate(request: NextRequest): Promise<
  { ok: true; who: string; permissions: string[] } | { ok: false; message: string }
> {
  const bearer = request.headers.get('authorization');
  if (bearer) {
    const identity: TokenIdentity | null = await verifyToken(bearer);
    if (!identity) return { ok: false, message: 'That token is not valid, or has been revoked.' };
    return { ok: true, who: `token:${identity.name}`, permissions: identity.permissions };
  }

  // A signed-in tab, so the endpoint is usable without minting a token first.
  const user = await getSessionUser();
  if (user?.isActive) return { ok: true, who: user.email ?? user.id, permissions: user.permissions };

  return { ok: false, message: 'Send an Authorization: Bearer token, or sign in.' };
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
  if (method.startsWith('notifications/')) return new NextResponse(null, { status: 202 });

  // The handshake is answered before authentication so a client can discover the
  // server and be told plainly that it needs a token, rather than seeing a
  // transport-level failure it cannot interpret.
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'gtm-radar', version: '1.0.0' },
    });
  }

  const auth = await authenticate(request);
  if (!auth.ok) return rpcError(id, -32001, auth.message, 401);
  const holder = { permissions: auth.permissions };

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
      headers: { Allow: 'POST' },
    });
  }

  return NextResponse.json({
    name: 'gtm-radar',
    transport: 'JSON-RPC 2.0 over POST',
    protocolVersion: PROTOCOL_VERSION,
    readOnly: true,
    tools: MCP_TOOLS.map((t) => t.name),
    auth: 'Authorization: Bearer <token from Settings>, or a signed-in session cookie.',
  });
}
