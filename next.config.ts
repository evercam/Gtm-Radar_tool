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
  // The roster and its workload were two views of the same people.
  { from: "/admin/users", to: "/control/team" },
  { from: "/control/import/gem", to: "/control/sources" },
  // Administration split out of the Control Center — keep the old paths alive.
  { from: "/control/settings", to: "/admin/settings" },
  { from: "/control/users", to: "/control/team" },
  // Search and the source catalog merged into one Source Hub.
  { from: "/control/search", to: "/control/sources" },
  { from: "/admin/sources", to: "/control/sources" },
  // KPI moved onto the Dashboard, where sellers already start their day.
  { from: "/control/kpi", to: "/" },
];

const nextConfig: NextConfig = {
  async redirects() {
    return CONTROL_REDIRECTS.map(({ from, to }) => ({
      source: from,
      destination: to,
      permanent: true,
    }));
  },
};

export default nextConfig;
