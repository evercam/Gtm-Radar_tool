/**
 * MCP server over the tool's own data, spoken over stdio.
 *
 * Answers the questions people keep asking this codebase in person — what is in
 * the pipeline, who holds it, what reached Apollo, why a lead did not — without
 * anyone opening a SQL client or re-deriving the eligibility rules by hand.
 *
 * Registered in `.mcp.json` at the repo root, so an agent picks it up on its own.
 *
 * The TOOLS are not defined here. They live in src/lib/mcp/tools.ts and are
 * shared with the `/api/mcp` HTTP endpoint, so a local agent and a remote one
 * cannot drift into answering different questions. This file is only the stdio
 * transport wrapped around them.
 *
 * No permission check here, deliberately. Each tool declares one and the HTTP
 * endpoint enforces it against a token's role — but over stdio the caller
 * already holds the service-role key in their own .env.local, so gating them
 * here would be theatre rather than security.
 *
 * READ ONLY. Every tool is a SELECT. Nothing assigns, exports, writes to Apollo
 * or edits a policy — the destructive paths exist as explicit scripts with dry
 * runs and APPLY=1 gates, and putting them behind a conversational interface
 * would remove exactly the friction that makes them safe.
 *
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/mcp-server.mjs
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { MCP_TOOLS, McpToolError } from '@/lib/mcp/tools';

/*
  stdout is the protocol channel.

  Anything printed there that is not JSON-RPC corrupts the stream and the client
  disconnects with no useful error. So every diagnostic goes to stderr, and this
  file must never call console.log.
*/
const log = (...args) => console.error('[mcp]', ...args);

if (!isSupabaseServiceConfigured()) {
  log('Supabase service role is not configured — start me with --env-file=.env.local');
  process.exit(1);
}

const server = new McpServer({ name: 'gtm-radar', version: '1.0.0' });

for (const tool of MCP_TOOLS) {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.schema },
    async (args) => {
      try {
        const result = await tool.run(args ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        // Uniform shape so an agent can recover instead of guessing.
        const payload =
          err instanceof McpToolError
            ? { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }
            : { code: 'unexpected', message: err instanceof Error ? err.message : String(err) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
log(`gtm-radar MCP server ready — ${MCP_TOOLS.length} read-only tools`);
