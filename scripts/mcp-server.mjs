/**
 * MCP server over the tool's own data.
 *
 * Answers the questions people keep asking this codebase in person — what is in
 * the pipeline, who holds it, what reached Apollo, why a lead did not — without
 * anyone opening a SQL client or re-deriving the eligibility rules by hand.
 *
 * Registered in `.mcp.json` at the repo root, so an agent picks it up on its own.
 *
 * READ ONLY, deliberately. Every tool here is a SELECT. Nothing assigns, exports,
 * writes to Apollo or edits a policy — the destructive paths already exist as
 * explicit scripts with dry runs and APPLY=1 gates, and putting them behind a
 * conversational interface would remove exactly the friction that makes them safe.
 * Adding a mutating tool later means adding a confirmation argument, not relaxing
 * this.
 *
 * Runs over stdio with the caller's own `.env.local`, so it introduces no new
 * network surface and no new credential. It reuses the app's own query layer
 * rather than re-implementing it, which is the point: the eligibility rules, the
 * phase normalisation and the handover gates stay defined in one place.
 *
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/mcp-server.mjs
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getRoster } from '@/lib/assignmentStore';
import { getHandoverByPerson, getExportRuns } from '@/lib/queries';
import { getEnrichmentPolicy } from '@/lib/policies';
import { renderRecordBrief } from '@/lib/export/recordBrief';
import { normalisePhase, PROJECT_PHASES } from '@/lib/phase';
import { partyLabel } from '@/lib/semantics';

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
const s = getServiceSupabase();

/** Uniform shape so an agent can recover instead of guessing. */
const fail = (code, message, details) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ code, message, ...(details ? { details } : {}) }, null, 2) }],
});
const ok = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });

/**
 * Pages a select to exhaustion.
 *
 * PostgREST caps a single response at 1000 rows, so an unpaged count is a sample
 * wearing a total's clothes — that mistake has already produced two wrong figures
 * in this project's history.
 *
 * The cap exists so a runaway query cannot page forever, but hitting it is
 * REPORTED rather than absorbed: a truncated total presented as a total is the
 * same lie the paging was added to prevent.
 */
const PAGE = 1000;
const MAX_PAGES = 200; // 200k rows — well clear of the ~60k on file.
async function pageAll(build) {
  const rows = [];
  let truncated = false;
  for (let p = 0; ; p += 1) {
    if (p >= MAX_PAGES) {
      truncated = true;
      break;
    }
    // A stable sort key is required, or ranges overlap and rows repeat.
    const { data, error } = await build().order('id', { ascending: true }).range(p * PAGE, (p + 1) * PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return { rows, truncated };
}

const server = new McpServer({ name: 'gtm-radar', version: '1.0.0' });

// ---------------------------------------------------------------------------

server.registerTool(
  'search_projects',
  {
    title: 'Search projects',
    description:
      'Find construction projects in the pipeline. Filters are combined with AND. Returns a summary row per project — use get_project for the full record. Phase filtering uses the normalised vocabulary, not the raw source wording.',
    inputSchema: {
      query: z.string().optional().describe('Case-insensitive match on project name or company name'),
      bu: z.enum(['usa', 'uk', 'ireland', 'apac', 'export']).optional().describe('Business unit'),
      vertical: z.string().optional().describe('e.g. construction, solar, procurement, oil_gas'),
      phase: z.enum(PROJECT_PHASES).optional().describe('Normalised phase, not the raw source value'),
      band: z.enum(['P1', 'P2', 'P3', 'P4']).optional().describe('Priority band'),
      assignee: z.string().optional().describe('Roster member name; matched loosely'),
      exported: z.boolean().optional().describe('true = already sent to Apollo, false = not yet'),
      hasContact: z.boolean().optional().describe('true = has an email or phone on file'),
      limit: z.number().int().min(1).max(200).default(25),
    },
  },
  async ({ query, bu, vertical, phase, band, assignee, exported, hasContact, limit = 25 }) => {
    try {
      let assigneeId = null;
      if (assignee?.trim()) {
        const { rows } = await getRoster();
        const hits = rows.filter((r) => r.name?.toLowerCase().includes(assignee.trim().toLowerCase()));
        if (hits.length === 0) {
          return fail('assignee_not_found', `No roster member matches "${assignee}".`, {
            available: rows.map((r) => r.name),
          });
        }
        if (hits.length > 1) {
          return fail('assignee_ambiguous', `"${assignee}" matches ${hits.length} people.`, {
            matches: hits.map((r) => r.name),
          });
        }
        assigneeId = hits[0].id;
      }

      let q = s
        .from('canonical_projects')
        .select(
          'id, ref_code, canonical_name, company_name_raw, icp_code, bu, vertical, current_phase, priority_band, priority_score, estimated_value, city, state_province, country, contact_name, contact_email, contact_phone, additional_contacts, assignee_id, apollo_exported_at'
        );
      if (bu) q = q.eq('bu', bu);
      if (vertical) q = q.eq('vertical', vertical);
      if (band) q = q.eq('priority_band', band);
      if (assigneeId) q = q.eq('assignee_id', assigneeId);
      if (exported === true) q = q.not('apollo_exported_at', 'is', null);
      if (exported === false) q = q.is('apollo_exported_at', null);
      if (hasContact === true) q = q.or('contact_email.not.is.null,contact_phone.not.is.null');
      if (query?.trim()) {
        const like = `%${query.trim()}%`;
        q = q.or(`canonical_name.ilike.${like},company_name_raw.ilike.${like}`);
      }

      /*
        Phase is normalised in code, not in SQL — 117 raw values map to 11, and the
        mapping lives in lib/phase.ts. So when filtering on phase we over-fetch and
        filter here, which is why the cap is generous but bounded.
      */
      const wantPhase = phase ?? null;
      const { data, error } = await q
        .order('priority_score', { ascending: false, nullsFirst: false })
        .limit(wantPhase ? Math.min(2000, limit * 40) : limit);
      if (error) return fail('query_failed', error.message);

      let rows = data ?? [];
      if (wantPhase) rows = rows.filter((r) => normalisePhase(r.current_phase) === wantPhase).slice(0, limit);

      return ok({
        count: rows.length,
        truncated: rows.length === limit,
        projects: rows.map((r) => ({
          id: r.id,
          ref: r.ref_code,
          name: r.canonical_name,
          company: r.company_name_raw,
          party: partyLabel(r.icp_code),
          bu: r.bu,
          vertical: r.vertical,
          phase: normalisePhase(r.current_phase),
          phaseRaw: r.current_phase,
          band: r.priority_band,
          score: r.priority_score,
          value: r.estimated_value,
          location: [r.city, r.state_province, r.country].filter(Boolean).join(', ') || null,
          contacts: (Array.isArray(r.additional_contacts) ? r.additional_contacts.length : 0) + (r.contact_name ? 1 : 0),
          reachable: Boolean(r.contact_email || r.contact_phone),
          exportedAt: r.apollo_exported_at,
        })),
      });
    } catch (err) {
      return fail('unexpected', err instanceof Error ? err.message : String(err));
    }
  }
);

// ---------------------------------------------------------------------------

server.registerTool(
  'get_project',
  {
    title: 'Get one project in full',
    description:
      'Everything held on a single project, including the rendered call brief a rep would read: why now, the facts, timing, the full contact committee, priority reasoning and the source link. Accepts either the record id or the ref code.',
    inputSchema: {
      id: z.string().optional().describe('The record id (uuid)'),
      ref: z.string().optional().describe('The ref_code, e.g. USA-PROC-US-7FA612FB'),
    },
  },
  async ({ id, ref }) => {
    if (!id && !ref) return fail('missing_argument', 'Give either id or ref.');
    try {
      let q = s.from('canonical_projects').select('*');
      q = id ? q.eq('id', id) : q.eq('ref_code', ref);
      const { data, error } = await q.limit(1);
      if (error) return fail('query_failed', error.message);
      const r = (data ?? [])[0];
      if (!r) return fail('not_found', `No project for ${id ? `id ${id}` : `ref ${ref}`}.`);

      const { rows: roster } = await getRoster();
      return ok({
        id: r.id,
        ref: r.ref_code,
        name: r.canonical_name,
        company: r.company_name_raw,
        party: partyLabel(r.icp_code),
        phase: normalisePhase(r.current_phase),
        phaseRaw: r.current_phase,
        assignedTo: roster.find((x) => x.id === r.assignee_id)?.name ?? null,
        exportedAt: r.apollo_exported_at,
        apolloContactId: r.apollo_contact_id,
        // The same text the export writes into Apollo, so both agree by construction.
        brief: renderRecordBrief(r, r.contact_email),
      });
    } catch (err) {
      return fail('unexpected', err instanceof Error ? err.message : String(err));
    }
  }
);

// ---------------------------------------------------------------------------

server.registerTool(
  'get_handover_status',
  {
    title: 'Who received leads, and what is stuck',
    description:
      'Per roster member: leads already sent to Apollo, leads ready to send on the next run, and the first blocking reason for the rest. Uses the export\'s own eligibility gates, so "ready" is what would genuinely be sent.',
    inputSchema: {},
  },
  async () => {
    try {
      const b = await getHandoverByPerson();
      if (b.tableMissing) return fail('migration_required', 'The roster table is missing — run the assignees migration.');
      return ok({
        requiresVerifiedEmail: b.requireVerified,
        unrosteredLeads: b.unrostered,
        people: b.rows.map((r) => ({
          name: r.name,
          active: r.isActive,
          dailyQuota: r.dailyQuota,
          received: r.received,
          readyToSend: r.ready,
          waitingOnContact: r.waitingOnContact,
          blockedUnverified: r.blockedUnverified,
          doNotContact: r.doNotContact,
        })),
      });
    } catch (err) {
      return fail('unexpected', err instanceof Error ? err.message : String(err));
    }
  }
);

// ---------------------------------------------------------------------------

server.registerTool(
  'list_export_runs',
  {
    title: 'Recent Apollo export runs',
    description:
      'History of sends to Apollo, newest first — when, who triggered it, what scope, and the created/existing/failed counts. Apollo raises no notification of its own, so this is the only record that an export happened.',
    inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
  },
  async ({ limit = 10 }) => {
    try {
      const { rows, tableMissing } = await getExportRuns(limit);
      if (tableMissing) return fail('migration_required', 'export_runs is missing — run the apollo_export migration.');
      return ok({
        count: rows.length,
        runs: rows.map((r) => ({
          startedAt: r.startedAt,
          trigger: r.trigger,
          scope: r.filters?.assignee ?? (r.filters?.bu ? `BU ${r.filters.bu}` : 'everyone'),
          requested: r.requested,
          created: r.created,
          existing: r.existing,
          failed: r.failed,
          status: r.status,
          durationMs: r.durationMs,
        })),
      });
    } catch (err) {
      return fail('unexpected', err instanceof Error ? err.message : String(err));
    }
  }
);

// ---------------------------------------------------------------------------

server.registerTool(
  'list_assignees',
  {
    title: 'The roster',
    description:
      'Who can receive leads, their daily quota, and the scope that decides which leads reach them. An empty bu/vertical/region list means no restriction on that axis, not "nothing".',
    inputSchema: { includeInactive: z.boolean().default(false) },
  },
  async ({ includeInactive = false }) => {
    try {
      const { rows, tableMissing } = await getRoster();
      if (tableMissing) return fail('migration_required', 'The assignees table is missing.');
      const people = rows.filter((r) => includeInactive || r.is_active);
      return ok({
        count: people.length,
        activeCount: rows.filter((r) => r.is_active).length,
        people: people.map((r) => ({
          name: r.name,
          email: r.email,
          role: r.role,
          active: r.is_active,
          dailyQuota: r.daily_lead_quota,
          bu: r.bu ?? [],
          verticals: r.verticals ?? [],
          regions: r.regions ?? [],
        })),
      });
    } catch (err) {
      return fail('unexpected', err instanceof Error ? err.message : String(err));
    }
  }
);

// ---------------------------------------------------------------------------

server.registerTool(
  'summarise_pipeline',
  {
    title: 'Pipeline totals',
    description:
      'Counts across the whole table, grouped by a dimension. Phase uses the normalised 11-value vocabulary. Paged, so totals are exact rather than a 1000-row sample.',
    inputSchema: {
      groupBy: z.enum(['phase', 'band', 'vertical', 'bu', 'party']).default('phase'),
    },
  },
  async ({ groupBy = 'phase' }) => {
    try {
      const { rows, truncated } = await pageAll(() =>
        s.from('canonical_projects').select('current_phase, priority_band, vertical, bu, icp_code, apollo_exported_at, assignee_id')
      );
      const keyOf = (r) => {
        if (groupBy === 'phase') return normalisePhase(r.current_phase) ?? '(unknown)';
        if (groupBy === 'band') return r.priority_band ?? '(unscored)';
        if (groupBy === 'party') return partyLabel(r.icp_code) ?? '(unknown)';
        return r[groupBy] ?? '(none)';
      };
      const tally = {};
      for (const r of rows) {
        const k = keyOf(r);
        tally[k] ??= { total: 0, assigned: 0, exported: 0 };
        tally[k].total += 1;
        if (r.assignee_id) tally[k].assigned += 1;
        if (r.apollo_exported_at) tally[k].exported += 1;
      }
      const { config } = await getEnrichmentPolicy();
      return ok({
        records: rows.length,
        // Loud, because a partial total read as a total is worse than no total.
        ...(truncated ? { truncated: true, warning: `Stopped at the ${MAX_PAGES * PAGE}-row page cap — counts below are a floor, not a total.` } : {}),
        groupBy,
        requireVerifiedEmail: config.requireChannel,
        groups: Object.entries(tally)
          .sort((a, b) => b[1].total - a[1].total)
          .map(([key, v]) => ({ key, ...v })),
      });
    } catch (err) {
      return fail('unexpected', err instanceof Error ? err.message : String(err));
    }
  }
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
log('gtm-radar MCP server ready — 6 read-only tools');
