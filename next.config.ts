import type { NextConfig } from "next";

/**
 * Operator tooling moved under /control/* so the everyday surface is just
 * Dashboard / My Leads / Key Accounts. These permanent redirects keep existing
 * bookmarks and any link shared before the move working.
 */
const CONTROL_REDIRECTS: { from: string; to: string }[] = [
  { from: "/search", to: "/control/sources" },
  { from: "/enrichment", to: "/control/enrichment" },
  { from: "/routing", to: "/control/routing" },
  { from: "/sources", to: "/control/sources" },
  { from: "/import", to: "/control/sources" },
  { from: "/settings", to: "/admin/settings" },
  { from: "/ingest", to: "/control/sources" },
  { from: "/ingest/gem", to: "/control/sources" },
  // Seeding folded into the hub: a schedule is a property of a source, not a
  // separate page.
  { from: "/control/seeding", to: "/control/sources" },
  { from: "/control/seeding/gem", to: "/control/sources" },
  // Uploads are sources too — they live in the hub, not on their own page.
  { from: "/control/import", to: "/control/sources" },
  { from: "/control/costs", to: "/admin/costs" },
  /*
    Team & Users moved from Operations to Administration.

    It sets quotas, scopes and roles — configuration, not the daily loop — and the
    dashboard links straight at it from three places, so a dead /control/team would
    be a broken link on the busiest page in the app rather than only a stale
    bookmark.
  */
  { from: "/control/team", to: "/admin/team" },
  // The roster and its workload were two views of the same people.
  { from: "/admin/users", to: "/admin/team" },
  { from: "/control/import/gem", to: "/control/sources" },
  // Administration split out of the Control Center — keep the old paths alive.
  { from: "/control/settings", to: "/admin/settings" },
  { from: "/control/users", to: "/admin/team" },
  // Search and the source catalog merged into one Source Hub.
  { from: "/control/search", to: "/control/sources" },
  { from: "/admin/sources", to: "/control/sources" },
  // KPI moved onto the Dashboard, where sellers already start their day.
  { from: "/control/kpi", to: "/" },
];

/**
 * OAuth discovery lives at paths the specifications fix, and none of them are
 * where the handler wants to live.
 *
 * RFC 8414 and RFC 9728 both mandate a `/.well-known/...` URL. Serving those from
 * a `.well-known` directory inside the app tree works, but scatters four related
 * handlers across two unrelated places — so the handlers sit together under
 * `/api/oauth/*` and the well-known URLs rewrite onto them. Rewrite, not redirect:
 * a client fetching discovery metadata is not obliged to follow a 307, and some
 * do not.
 *
 * The last entry is the one that repairs the original failure. A client that finds
 * no metadata falls back to assuming the MCP origin is also the authorization
 * server and posts its registration to `/register` on it. That used to hit the
 * catch-all and redirect to the sign-in page, which surfaces to the user as
 * "couldn't register with the sign-in service" — so it now lands on the real
 * registration endpoint, and a client that never reads our metadata still works.
 */
const OAUTH_REWRITES: { source: string; destination: string }[] = [
  { source: '/.well-known/oauth-authorization-server', destination: '/api/oauth/metadata/authorization-server' },
  // Some clients append the resource path to the AS metadata URL too. Harmless to
  // answer, and it costs one line against a discovery failure with no diagnostic.
  { source: '/.well-known/oauth-authorization-server/api/mcp', destination: '/api/oauth/metadata/authorization-server' },
  /*
    Not an OpenID provider — there is no id_token here and no userinfo endpoint —
    but a good number of clients probe this path first out of habit. The OAuth
    metadata is a strict subset of what they are looking for, and the fields they
    need for an authorization code flow are all present.
  */
  { source: '/.well-known/openid-configuration', destination: '/api/oauth/metadata/authorization-server' },
  { source: '/.well-known/oauth-protected-resource/api/mcp', destination: '/api/oauth/metadata/protected-resource' },
  // RFC 9728 puts the resource path inside the well-known path; a client that
  // instead asks for the bare document should still be told who guards the MCP
  // endpoint, since that is the only protected resource here.
  { source: '/.well-known/oauth-protected-resource', destination: '/api/oauth/metadata/protected-resource' },
  { source: '/register', destination: '/api/oauth/register' },
];

const nextConfig: NextConfig = {
  async redirects() {
    return CONTROL_REDIRECTS.map(({ from, to }) => ({
      source: from,
      destination: to,
      permanent: true,
    }));
  },
  async rewrites() {
    return OAUTH_REWRITES;
  },
};

export default nextConfig;
