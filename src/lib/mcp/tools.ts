import 'server-only';
import { z } from 'zod';
import { getServiceSupabase } from '@/lib/supabase/server';
import { getRoster } from '@/lib/assignmentStore';
import { getHandoverByPerson, getExportRuns, getSourceStats, getAccountDetail } from '@/lib/queries';
import { getEnrichmentPolicy } from '@/lib/policies';
import { getIngestionRuns } from '@/lib/sources/runs';
import { getAllSourceConfigs } from '@/lib/sources/config';
import { SOURCE_CATALOG } from '@/lib/sourceCatalog';
import { renderRecordBrief } from '@/lib/export/recordBrief';
import { normalisePhase, PROJECT_PHASES } from '@/lib/phase';
import { partyLabel, VERTICALS } from '@/lib/semantics';
import type { Permission } from '@/lib/auth/roles';

/**
 * The MCP tools, defined once and served over two transports.
 *
 * `scripts/mcp-server.mjs` exposes them over stdio to a local agent; the
 * `/api/mcp` route exposes the same list over HTTP to a bearer-token client.
 * They were briefly going to be two implementations, which is how the two copies
 * drift until one of them quietly answers a different question — so the handlers
 * live here and both transports are thin.
 *
 * Each tool declares the PERMISSION it needs, so the HTTP endpoint can gate on
 * the same matrix as the UI. Over stdio there is no session to gate on: the
 * caller already has the service-role key in their own .env.local, and pretending
 * otherwise would be theatre.
 *
 * READ ONLY. Every handler is a SELECT. Nothing assigns, exports, writes to
 * Apollo or edits a policy — those paths stay as scripts with dry runs and
 * APPLY=1 gates, because the gate is the thing that makes somebody read what is
 * about to change.
 */

/**
 * The behavioural hints a client uses to decide whether to run a tool without
 * asking. Part of the protocol rather than prose, which matters here: a hosted
 * client's research mode invokes connector tools with no per-call approval, so
 * "this only reads" has to be something it can check, not something written in
 * a comment it will never see.
 */
export interface McpToolAnnotations {
  /** No side effects. The whole server is this today; a mutating tool is not. */
  readOnlyHint: boolean;
  /** Calling twice changes nothing beyond calling once. */
  idempotentHint: boolean;
  /** Whether it reaches beyond a closed, known set of entities. */
  openWorldHint: boolean;
  /** Only meaningful when readOnlyHint is false; stated anyway so it is never absent. */
  destructiveHint: boolean;
}

/**
 * Every tool here is a SELECT against our own tables.
 *
 * Spread explicitly at each tool rather than defaulted in the transports, and
 * REQUIRED on the interface below, so the first tool that is not read-only
 * cannot inherit this by omission — it has to say so, and the compiler makes it.
 * Same direction as `truncated` in pageAll: the unsafe value is the earned one.
 */
const READ_ONLY: McpToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
  destructiveHint: false,
};

export interface McpTool {
  name: string;
  title: string;
  description: string;
  /** Raw zod shape — the SDK wants this, and JSON Schema is derived from it. */
  schema: Record<string, z.ZodTypeAny>;
  /** What a caller must hold. Enforced over HTTP; stdio is already trusted. */
  permission: Permission;
  /** Required, not optional — see READ_ONLY. */
  annotations: McpToolAnnotations;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Raised by a handler when the caller's arguments cannot be satisfied. */
export class McpToolError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const s = () => getServiceSupabase();

/**
 * Pages a select to exhaustion.
 *
 * PostgREST caps a single response at 1000 rows, so an unpaged count is a sample
 * wearing a total's clothes — that mistake has already produced two wrong figures
 * in this project. Hitting the page cap is REPORTED rather than absorbed.
 */
const PAGE = 1000;
const MAX_PAGES = 200;

/**
 * The slice of the PostgREST builder this needs.
 *
 * Declared structurally rather than by importing the client's own generics:
 * threading those through a helper is what previously made the compiler give up
 * with "type instantiation is excessively deep", and the casts to silence it
 * were worse than the problem.
 */
interface KeysetPage extends PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> {
  /** The keyset predicate. Returns the same shape so it can be applied or not. */
  gt: (column: string, value: string) => KeysetPage;
}

interface KeysetQuery {
  order: (column: string, opts: { ascending: boolean }) => { limit: (n: number) => KeysetPage };
}

/**
 * Pages a select to exhaustion by KEYSET, not by offset.
 *
 * Only a fallback now — gtm_summarise_pipeline aggregates in SQL — but it carried the
 * same fault queries.ts documented and fixed in getSourceStats, and left unfixed
 * it is a trap for whoever calls it next.
 *
 * `.range(p * PAGE, …)` is OFFSET/LIMIT, so Postgres produces and discards every
 * row before the window: page 110 pays for the previous 109,000 and the cost grows
 * with the square of the table. `id > last` reads the same 1,000 rows wherever it
 * sits, so it stays flat as the table grows.
 *
 * BE CLEAR ABOUT WHAT THIS DID AND DID NOT FIX. Measured against 109,552 rows,
 * this walk takes ~106 s, where offset paging with eight pages in flight took
 * ~72 s. Keyset is SLOWER here, because it is necessarily sequential — each page
 * needs the previous page's last id — and 110 round trips cost more than the
 * scans they avoid at this size. It is kept because it does not degrade
 * quadratically as the table grows and it cannot skip or repeat rows across a page
 * boundary, not because it made anything faster today.
 *
 * The lesson being that no pagination strategy fixes this: 109,552 rows should not
 * cross the wire to produce twelve numbers. That is what pipeline_rollup is for,
 * and this path exists only so the tool still answers before that migration is
 * applied.
 */
async function pageAll(build: () => KeysetQuery) {
  const rows: Record<string, unknown>[] = [];
  let truncated = true;
  let after = '';

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let q = build().order('id', { ascending: true }).limit(PAGE);
    // A total order is required either way, or a page boundary repeats and skips
    // rows — which would misreport every total this feeds.
    if (after) q = q.gt('id', after);

    const { data, error } = await q;
    if (error) throw new McpToolError('query_failed', error.message);

    const batch = (data ?? []) as Record<string, unknown>[];
    if (batch.length === 0) {
      truncated = false;
      break;
    }

    // Pushed in chunks rather than spread whole: one spread of 100k+ arguments
    // overflows the call stack.
    rows.push(...batch);

    if (batch.length < PAGE) {
      truncated = false;
      break;
    }
    after = batch[batch.length - 1].id as string;
  }

  /*
    `truncated` starts true and is cleared only on reaching a genuine end, so the
    page cap can never be mistaken for the end of the table. The direction is
    deliberate: a partial total reported as a total is the failure this helper
    exists to prevent, so the unsafe value is the one that has to be earned.
  */
  return { rows, truncated };
}

/*
  One string literal, deliberately not a concatenation.

  supabase-js infers the row type from the select TEXT, and it can only do that
  when the argument is a literal. Built by joining or concatenating, the inference
  collapses to `GenericStringError[]` and every field access downstream becomes a
  cast. Long line, correct types.
*/
const PROJECT_COLUMNS =
  'id, ref_code, canonical_name, company_name_raw, account_key, icp_code, bu, vertical, current_phase, priority_band, priority_score, estimated_value, estimated_value_currency, building_type, source_key, city, state_province, country, contact_name, contact_email, contact_phone, additional_contacts, assignee_id, apollo_exported_at';

/**
 * A page position, as an opaque string.
 *
 * Opaque on purpose: it encodes the sort key of the last row handed out
 * (`priority_score`, then `id` to break ties), and a caller that parsed it would
 * be depending on the sort order never changing. Base64url keeps it one token and
 * visibly not-for-editing.
 */
interface Cursor {
  /** The last row's score. Null is legitimate — unscored rows sort last. */
  s: number | null;
  i: string;
}

const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof c?.i !== 'string' || (c.s !== null && typeof c.s !== 'number')) throw new Error('shape');
    return c;
  } catch {
    throw new McpToolError('invalid_cursor', 'That cursor is not one this tool issued. Omit it to start from the first page.');
  }
}

/**
 * The keyset predicate for "everything after this row", under
 * `ORDER BY priority_score DESC NULLS LAST, id ASC`.
 *
 * Keyset rather than an offset, for the reason pageAll documents: OFFSET makes
 * Postgres produce and discard every row before the window, so deep pages get
 * quadratically more expensive, and a row inserted mid-walk shifts the window and
 * silently skips or repeats one. The cost here is that nulls-last has to be
 * spelled out — there is no tuple comparison that models it — so the position is
 * one of two cases:
 *
 *   scored row: everything scoring less, plus ties broken by id, plus the whole
 *               unscored tail (which sorts after every scored row).
 *   unscored:   already in the tail, so only later ids in it.
 */
function afterCursor(c: Cursor): string {
  if (c.s === null) return `and(priority_score.is.null,id.gt.${c.i})`;
  return [
    `priority_score.lt.${c.s}`,
    `and(priority_score.eq.${c.s},id.gt.${c.i})`,
    'priority_score.is.null',
  ].join(',');
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'gtm_search_projects',
    title: 'Search projects',
    description:
      'Find construction projects in the pipeline, highest priority score first. Filters are combined with AND. Returns a summary row per project — use gtm_get_project for the full record. Phase filtering uses the normalised vocabulary, not the raw source wording. When truncated is true a nextCursor is returned: call again with that cursor and identical filters to get the following page.',
    permission: 'leads.view.all',
    annotations: READ_ONLY,
    schema: {
      query: z.string().optional().describe('Case-insensitive match on project name or company name'),
      bu: z.enum(['usa', 'uk', 'ireland', 'apac', 'export']).optional().describe('Business unit'),
      /*
        An enum, not a free string. It was the latter, described with three
        examples — which meant a plausible-but-wrong guess ("energy", "solar_pv")
        came back as an empty result set indistinguishable from a real one. The
        list is the classifier's own, so it cannot drift from what is stored.
      */
      vertical: z.enum(VERTICALS).optional().describe('Classifier vertical'),
      phase: z.enum(PROJECT_PHASES).optional().describe('Normalised phase, not the raw source value'),
      band: z.enum(['P1', 'P2', 'P3', 'P4']).optional().describe('Priority band'),
      assignee: z.string().optional().describe('Roster member name; matched loosely'),
      exported: z.boolean().optional().describe('true = already sent to Apollo, false = not yet'),
      hasContact: z.boolean().optional().describe('true = has an email or phone on file'),
      source: z.string().optional().describe('source_key, e.g. find_a_tender_uk, gem_energy_tracker'),
      buildingType: z
        .string()
        .optional()
        .describe('Substring of building_type. "Healthcare" finds the NHS construction leads.'),
      minValue: z.number().optional().describe('Minimum estimated_value'),
      limit: z.number().int().min(1).max(200).default(25),
      cursor: z
        .string()
        .optional()
        .describe('nextCursor from a previous call, to fetch the following page. Keep every other filter identical.'),
    },
    async run(a) {
      const limit = (a.limit as number) ?? 25;
      let assigneeId: string | null = null;
      const assignee = a.assignee as string | undefined;
      if (assignee?.trim()) {
        const { rows } = await getRoster();
        const hits = rows.filter((r) => r.name?.toLowerCase().includes(assignee.trim().toLowerCase()));
        if (hits.length === 0) {
          throw new McpToolError('assignee_not_found', `No roster member matches "${assignee}".`, {
            available: rows.map((r) => r.name),
          });
        }
        if (hits.length > 1) {
          throw new McpToolError('assignee_ambiguous', `"${assignee}" matches ${hits.length} people.`, {
            matches: hits.map((r) => r.name),
          });
        }
        assigneeId = hits[0].id;
      }

      const cursor = a.cursor ? decodeCursor(a.cursor as string) : null;

      /*
        Built as a thunk because the phase filter may have to be retried without
        the indexed column — see runPage below. A single mutated builder cannot be
        replayed.
      */
      const build = (usePhaseColumn: boolean) => {
        let q = s().from('canonical_projects').select(PROJECT_COLUMNS);
        if (a.bu) q = q.eq('bu', a.bu as string);
        if (a.vertical) q = q.eq('vertical', a.vertical as string);
        if (a.band) q = q.eq('priority_band', a.band as string);
        if (assigneeId) q = q.eq('assignee_id', assigneeId);
        if (a.exported === true) q = q.not('apollo_exported_at', 'is', null);
        if (a.exported === false) q = q.is('apollo_exported_at', null);
        if (a.hasContact === true) q = q.or('contact_email.not.is.null,contact_phone.not.is.null');
        if (a.source) q = q.eq('source_key', (a.source as string).trim());
        if (a.buildingType) q = q.ilike('building_type', `%${(a.buildingType as string).trim()}%`);
        if (a.minValue != null) q = q.gte('estimated_value', a.minValue as number);
        if (a.query) {
          const like = `%${(a.query as string).trim()}%`;
          q = q.or(`canonical_name.ilike.${like},company_name_raw.ilike.${like}`);
        }
        /*
          Phase, as an indexed WHERE clause.

          `phase_normalised` is a stored generated column running the same 117→11
          mapping as lib/phase.ts, emitted from it by scripts/generate-phase-sql.mjs
          and pinned by scripts/test-phase-parity.mjs. Before it existed this filter
          could not be pushed into SQL at all: the tool fetched the top `limit * 40`
          rows by score and folded them here, so every matching project below that
          score cutoff was invisible and a short result read as a small total.
        */
        if (a.phase && usePhaseColumn) q = q.eq('phase_normalised', a.phase as string);
        if (cursor) q = q.or(afterCursor(cursor));
        return q.order('priority_score', { ascending: false, nullsFirst: false }).order('id', { ascending: true });
      };

      const wantPhase = (a.phase as string) ?? null;

      /*
        One row more than we intend to keep, so "there are more" is observed rather
        than guessed. `rows.length === limit` used to stand in for it, which reports
        a search returning exactly its limit as truncated.
      */
      let { data, error } = await build(true).limit(limit + 1);

      /*
        The migration may not be applied yet, so fall back to the old fold.

        Same reasoning as gtm_summarise_pipeline's rollup fallback: a slow, caveated
        answer beats `migration_required` from a tool whose whole job is finding
        projects, and the branch disappears once the column exists. Matched on the
        column name so an unrelated failure still surfaces as itself.
      */
      let degraded = false;
      if (error && wantPhase && /phase_normalised/.test(error.message)) {
        degraded = true;
        ({ data, error } = await build(false).limit(Math.min(2000, limit * 40) + 1));
      }
      if (error) throw new McpToolError('query_failed', error.message);

      const scanned = (data ?? []) as Record<string, unknown>[];
      const cap = degraded ? Math.min(2000, limit * 40) : limit;
      /* Fewer back than we asked for ⇒ we have seen every row matching the filters. */
      const sawEverything = scanned.length <= cap;

      let rows: Record<string, unknown>[];
      let truncated: boolean;
      let warning: string | null = null;

      if (degraded) {
        const matched = scanned.slice(0, cap).filter((r) => normalisePhase(r.current_phase as string) === wantPhase);
        truncated = !sawEverything || matched.length > limit;
        if (!sawEverything) {
          warning =
            `phase_normalised is missing, so this fell back to scanning the top ${cap} projects by score and folding phase in code. ` +
            `Lower-scoring projects in "${wantPhase}" were not examined. Apply 20260818220000_phase_normalised.sql for an exhaustive answer.`;
        }
        rows = matched.slice(0, limit);
      } else {
        truncated = !sawEverything;
        rows = scanned.slice(0, limit);
      }

      /*
        The cursor is the LAST ROW HANDED OUT, so the next page resumes exactly
        after it. Only issued when there is a next page — an agent can treat a
        present nextCursor as "there is more" without comparing counts.
      */
      const last = rows[rows.length - 1];
      const nextCursor =
        truncated && last
          ? encodeCursor({ s: (last.priority_score as number | null) ?? null, i: last.id as string })
          : null;

      return {
        count: rows.length,
        truncated,
        nextCursor,
        ...(warning ? { warning } : {}),
        projects: rows.map((r) => ({
          id: r.id,
          ref: r.ref_code,
          name: r.canonical_name,
          company: r.company_name_raw,
          // The handle gtm_get_account takes. Without it that tool is unreachable.
          accountKey: r.account_key,
          party: partyLabel(r.icp_code as string),
          bu: r.bu,
          vertical: r.vertical,
          phase: normalisePhase(r.current_phase as string),
          phaseRaw: r.current_phase,
          band: r.priority_band,
          score: r.priority_score,
          value: r.estimated_value,
          currency: r.estimated_value_currency,
          buildingType: r.building_type,
          source: r.source_key,
          location: [r.city, r.state_province, r.country].filter(Boolean).join(', ') || null,
          contacts:
            (Array.isArray(r.additional_contacts) ? (r.additional_contacts as unknown[]).length : 0) +
            (r.contact_name ? 1 : 0),
          reachable: Boolean(r.contact_email || r.contact_phone),
          exportedAt: r.apollo_exported_at,
        })),
      };
    },
  },

  {
    name: 'gtm_get_project',
    title: 'Get one project in full',
    description:
      'Everything held on a single project, including the rendered call brief a rep would read: why now, the facts, timing, the full contact committee, priority reasoning and the source link. Accepts either the record id or the ref code.',
    permission: 'leads.view.all',
    annotations: READ_ONLY,
    schema: {
      id: z.string().optional().describe('The record id (uuid)'),
      ref: z.string().optional().describe('The ref_code, e.g. USA-PROC-US-7FA612FB'),
    },
    async run(a) {
      if (!a.id && !a.ref) throw new McpToolError('missing_argument', 'Give either id or ref.');
      let q = s().from('canonical_projects').select('*');
      q = a.id ? q.eq('id', a.id as string) : q.eq('ref_code', a.ref as string);
      const { data, error } = await q.limit(1);
      if (error) throw new McpToolError('query_failed', error.message);
      const r = ((data ?? []) as unknown as Record<string, unknown>[])[0];
      if (!r) throw new McpToolError('not_found', `No project for ${a.id ? `id ${a.id}` : `ref ${a.ref}`}.`);

      const { rows: roster } = await getRoster();
      /*
        A superset of the search row, deliberately.

        This drills down from gtm_search_projects, and it used to return TWELVE
        fields where the summary returns twenty — band, score, value, location,
        building type and source all vanished on the way in. Following a search
        into one record lost information, which is backwards. Whatever the
        summary carries, the detail carries too, under the same names so the two
        shapes line up.
      */
      return {
        id: r.id,
        ref: r.ref_code,
        name: r.canonical_name,
        company: r.company_name_raw,
        accountKey: r.account_key,
        party: partyLabel(r.icp_code as string),
        bu: r.bu,
        vertical: r.vertical,
        phase: normalisePhase(r.current_phase as string),
        phaseRaw: r.current_phase,
        band: r.priority_band,
        score: r.priority_score,
        value: r.estimated_value,
        currency: r.estimated_value_currency,
        buildingType: r.building_type,
        source: r.source_key,
        location: [r.city, r.state_province, r.country].filter(Boolean).join(', ') || null,
        contacts:
          (Array.isArray(r.additional_contacts) ? (r.additional_contacts as unknown[]).length : 0) +
          (r.contact_name ? 1 : 0),
        reachable: Boolean(r.contact_email || r.contact_phone),
        assignedTo: roster.find((x) => x.id === r.assignee_id)?.name ?? null,
        exportedAt: r.apollo_exported_at,
        apolloContactId: r.apollo_contact_id,
        // The same text the export writes into Apollo, so both agree by construction.
        brief: renderRecordBrief(r as never, r.contact_email as string),
      };
    },
  },

  {
    name: 'gtm_get_handover_status',
    title: 'Who received leads, and what is stuck',
    description:
      'Per roster member: leads already sent to Apollo, leads ready to send on the next run, and the first blocking reason for the rest. Uses the export\'s own eligibility gates, so "ready" is what would genuinely be sent.',
    permission: 'kpi.view.team',
    annotations: READ_ONLY,
    schema: {},
    async run() {
      const b = await getHandoverByPerson();
      if (b.tableMissing) throw new McpToolError('migration_required', 'The roster table is missing.');
      return {
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
      };
    },
  },

  {
    name: 'gtm_list_export_runs',
    title: 'Recent Apollo export runs',
    description:
      'History of sends to Apollo, newest first — when, who triggered it, what scope, and the created/existing/failed counts. Apollo raises no notification of its own, so this is the only record that an export happened.',
    /*
      Reading the history is not exporting.

      This was gated on `leads.export`, which meant somebody who could see the
      handover board could not see whether the export they were waiting on had
      actually run — the immediate next question, refused. Aligned with the other
      reporting tools; triggering an export is still a script with its own gate.
    */
    permission: 'kpi.view.team',
    annotations: READ_ONLY,
    schema: { limit: z.number().int().min(1).max(50).default(10) },
    async run(a) {
      const { rows, tableMissing } = await getExportRuns((a.limit as number) ?? 10);
      if (tableMissing) throw new McpToolError('migration_required', 'export_runs is missing.');
      return {
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
      };
    },
  },

  {
    name: 'gtm_list_assignees',
    title: 'The roster',
    description:
      'Who can receive leads, their daily quota, and the scope that decides which leads reach them. An empty bu/vertical/region list means no restriction on that axis, not "nothing".',
    permission: 'kpi.view.team',
    annotations: READ_ONLY,
    schema: { includeInactive: z.boolean().default(false) },
    async run(a) {
      const { rows, tableMissing } = await getRoster();
      if (tableMissing) throw new McpToolError('migration_required', 'The assignees table is missing.');
      const people = rows.filter((r) => a.includeInactive || r.is_active);
      return {
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
      };
    },
  },

  {
    name: 'gtm_summarise_pipeline',
    title: 'Pipeline totals',
    description:
      'Counts across the whole table, grouped by a dimension. Phase uses the normalised 11-value vocabulary. Paged, so totals are exact rather than a 1000-row sample.',
    permission: 'kpi.view.team',
    annotations: READ_ONLY,
    schema: { groupBy: z.enum(['phase', 'band', 'vertical', 'bu', 'party']).default('phase') },
    async run(a) {
      const groupBy = (a.groupBy as string) ?? 'phase';

      /*
        The normalised group key for one grouping row.

        Shared by both paths below, which is the point: phase and party are
        normalised in TypeScript — 117 raw phase strings map to 11 through
        lib/phase.ts — so the SQL aggregate groups by the RAW columns and the
        folding happens here. One definition of what a phase is, rather than a
        second one in SQL that would drift from it.
      */
      const keyOf = (r: Record<string, unknown>) => {
        if (groupBy === 'phase') return normalisePhase(r.current_phase as string) ?? '(unknown)';
        if (groupBy === 'band') return (r.priority_band as string) ?? '(unscored)';
        if (groupBy === 'party') return partyLabel(r.icp_code as string) ?? '(unknown)';
        return (r[groupBy] as string) ?? '(none)';
      };

      const tally: Record<string, { total: number; assigned: number; exported: number }> = {};
      const add = (r: Record<string, unknown>, n: number, assigned: boolean, exported: boolean) => {
        const k = keyOf(r);
        tally[k] ??= { total: 0, assigned: 0, exported: 0 };
        tally[k].total += n;
        if (assigned) tally[k].assigned += n;
        if (exported) tally[k].exported += n;
      };

      let records = 0;
      let truncated = false;

      /*
        Count in the database. One round trip, one hash aggregate.

        This tool used to pull all 109,552 rows across the wire to produce twelve
        numbers, which took 64-81 seconds and timed out in any client with a
        sensible request deadline. Nothing about twelve numbers requires the rows
        to leave Postgres.
      */
      const { data: rollup, error: rollupError } = await s().rpc('pipeline_rollup');

      if (!rollupError && Array.isArray(rollup)) {
        for (const g of rollup as Record<string, unknown>[]) {
          const n = Number(g.n) || 0;
          records += n;
          add(g, n, Boolean(g.assigned), Boolean(g.exported));
        }
      } else {
        /*
          The migration is not applied yet, so fall back to walking the table.

          Slow — this is the 64-81 second path — but a slow exact answer beats
          `migration_required` on a tool whose whole job is the totals, and the
          fallback disappears the moment the function exists. Any other error also
          lands here rather than failing outright, on the same reasoning.
        */
        const paged = await pageAll(
          () =>
            s()
              .from('canonical_projects')
              .select('id, current_phase, priority_band, vertical, bu, icp_code, apollo_exported_at, assignee_id') as unknown as KeysetQuery
        );
        truncated = paged.truncated;
        records = paged.rows.length;
        for (const r of paged.rows) add(r, 1, Boolean(r.assignee_id), Boolean(r.apollo_exported_at));
      }

      const { config } = await getEnrichmentPolicy();
      return {
        records,
        // Loud, because a partial total read as a total is worse than no total.
        ...(truncated
          ? { truncated: true, warning: `Stopped at the ${MAX_PAGES * PAGE}-row page cap — counts are a floor.` }
          : {}),
        groupBy,
        requireVerifiedEmail: config.requireChannel,
        groups: Object.entries(tally)
          .sort((x, y) => y[1].total - x[1].total)
          .map(([key, v]) => ({ key, ...v })),
      };
    },
  },

  {
    name: 'gtm_list_sources',
    title: 'Where the data comes from',
    description:
      'Every source the tool can pull from, with how many records it has contributed, how complete they are, when it last delivered, and whether it is switched on. Use this to answer "why do we have no leads in X" before assuming the pipeline is broken.',
    permission: 'sources.run',
    annotations: READ_ONLY,
    schema: { withRecordsOnly: z.boolean().default(false) },
    async run(a) {
      const [stats, cfg] = await Promise.all([getSourceStats(), getAllSourceConfigs()]);
      const rows = SOURCE_CATALOG.map((c) => {
        const st = stats[c.sourceKey];
        const conf = c.slug ? cfg.configs[c.slug] : undefined;
        return {
          name: c.name,
          sourceKey: c.sourceKey,
          slug: c.slug ?? null,
          category: c.category,
          coverage: c.coverage,
          auth: c.auth,
          records: st?.count ?? 0,
          avgCompleteness: st?.avgCompleteness ?? null,
          lastIngested: st?.lastIngested ?? null,
          enabled: conf?.isEnabled ?? null,
          schedule: conf?.scheduleCron ?? null,
          maxRecordsPerRun: conf?.maxRecordsPerRun ?? null,
        };
      })
        .filter((r) => !a.withRecordsOnly || r.records > 0)
        .sort((x, y) => y.records - x.records);
      return {
        count: rows.length,
        totalRecords: rows.reduce((n, r) => n + r.records, 0),
        configTableMissing: cfg.tableMissing,
        sources: rows,
      };
    },
  },

  {
    name: 'gtm_list_ingestion_runs',
    title: 'Recent source pulls',
    description:
      'History of fetches FROM sources — distinct from gtm_list_export_runs, which is sends TO Apollo. Shows what ran, over what window, and how many records arrived, plus the error when one failed.',
    permission: 'sources.run',
    annotations: READ_ONLY,
    schema: {
      source: z.string().optional().describe('Slug, e.g. find-a-tender, gem, nyc-permits'),
      limit: z.number().int().min(1).max(100).default(15),
    },
    async run(a) {
      const { runs, tableMissing } = await getIngestionRuns({
        slug: a.source as string | undefined,
        limit: (a.limit as number) ?? 15,
      });
      if (tableMissing) throw new McpToolError('migration_required', 'ingestion_runs is missing.');
      return {
        count: runs.length,
        runs: runs.map((r) => ({
          startedAt: r.startedAt,
          source: r.slug,
          trigger: r.trigger,
          status: r.status,
          fetched: r.fetched,
          inserted: r.inserted,
          updated: r.updated,
          duplicates: r.duplicates,
          failed: r.failed,
          durationMs: r.durationMs,
          error: r.error,
          params: r.params,
        })),
      };
    },
  },

  {
    name: 'gtm_get_account',
    title: 'One company and every project it touches',
    description:
      'A company-level view rather than a per-project one: the account record, its enrichment, and its linked projects, highest-scoring first. This is the view for "what else is this contractor doing" before a call. projectCount is the true total; the projects list is capped, so compare it against projectsShown before summarising a portfolio.',
    permission: 'leads.view.all',
    annotations: READ_ONLY,
    schema: { accountKey: z.string().describe('The normalised account_key, as returned on a project') },
    async run(a) {
      const key = a.accountKey as string;
      const d = await getAccountDetail(key);
      if (!d.view && !d.account && d.projectCount === 0) {
        throw new McpToolError('not_found', `No account for key "${key}".`);
      }
      return {
        accountKey: key,
        name: d.view?.account_name ?? d.account?.company_name_raw ?? null,
        role: d.view?.account_role ?? null,
        keyAccount: d.view?.key_account ?? null,
        totalValue: d.view?.total_value ?? null,
        projectCount: d.projectCount,
        /*
          getAccountDetail caps the linked projects at 50 while counting exactly,
          so on a large contractor these two disagree — and nothing said so. An
          agent reading fifty rows next to a count of three hundred, with no
          marker between them, describes the fifty as the portfolio. Named and
          flagged, in the same shape the search tool uses.
        */
        projectsShown: d.projects.length,
        truncated: d.projects.length < d.projectCount,
        enrichment: d.enrichment
          ? {
              parentAccount: d.enrichment.parent_account,
              expansionSignal: d.enrichment.expansion_signal,
              relatedEntities: d.enrichment.related_entities?.length ?? 0,
              portfolioProjects: d.enrichment.portfolio_project_count,
            }
          : null,
        projects: d.projects.map((p) => ({
          ref: p.ref_code,
          name: p.canonical_name,
          phase: normalisePhase(p.current_phase),
          buildingType: p.building_type,
          value: p.estimated_value,
          currency: p.estimated_value_currency,
          exportedAt: p.apollo_exported_at,
        })),
      };
    },
  },
];

/** JSON Schema for a tool's arguments, derived from the zod shape. */
export function toolInputSchema(tool: McpTool): Record<string, unknown> {
  return z.toJSONSchema(z.object(tool.schema)) as Record<string, unknown>;
}

export function findTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}
