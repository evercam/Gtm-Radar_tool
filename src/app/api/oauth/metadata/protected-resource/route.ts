import { NextResponse, type NextRequest } from 'next/server';
import { protectedResourceMetadata } from '@/lib/auth/oauth/metadata';

export const dynamic = 'force-dynamic';

/**
 * RFC 9728 protected resource metadata.
 *
 * Served at `/.well-known/oauth-protected-resource/api/mcp` by a rewrite in
 * next.config.ts, not from a `.well-known` directory in the app tree. Two
 * reasons, and the second is the one that matters: the well-known path is fixed
 * by the specification and the handler's location is not, so keeping the handler
 * beside the rest of the OAuth code is simply where somebody will look for it —
 * and a rewrite means the discovery URL, the registration endpoint and the token
 * endpoint are all listed in one place when a path needs to change.
 *
 * This is the FIRST thing a client fetches after being turned away by the MCP
 * endpoint, and everything downstream depends on it being reachable
 * unauthenticated. See the PUBLIC_PATHS entry in proxy.ts: without it, this
 * answers a redirect to the sign-in page and the client concludes there is no
 * OAuth server here.
 */
export async function GET(request: NextRequest) {
  return NextResponse.json(protectedResourceMetadata(request.nextUrl.origin), {
    headers: {
      /*
        Cacheable, and CORS-open. Both are required rather than convenient: a
        browser-based MCP client fetches this cross-origin, and a metadata
        document that cannot be read from another origin is a discovery failure
        with no diagnostic. Nothing here is secret — it is four URLs and a scope
        name, all derived from the host the caller already used.
      */
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** Pre-flighted by browser clients before the GET above. */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
      'Access-Control-Max-Age': '86400',
    },
  });
}
