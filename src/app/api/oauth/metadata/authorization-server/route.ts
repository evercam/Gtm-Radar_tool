import { NextResponse, type NextRequest } from 'next/server';
import { authorizationServerMetadata } from '@/lib/auth/oauth/metadata';

export const dynamic = 'force-dynamic';

/**
 * RFC 8414 authorization server metadata.
 *
 * Served at `/.well-known/oauth-authorization-server` — and also at
 * `/.well-known/openid-configuration`, by rewrite, because a good number of
 * clients look there first out of habit even for a server that is not an OpenID
 * provider. Answering both costs one line of config and removes a whole class of
 * "discovery failed" with no explanation.
 *
 * The `issuer` here must match this document's own origin exactly. It does,
 * because both come from the request — which is what makes a preview deployment
 * work as its own authorization server without a variable to set.
 */
export async function GET(request: NextRequest) {
  return NextResponse.json(authorizationServerMetadata(request.nextUrl.origin), {
    headers: {
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

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
