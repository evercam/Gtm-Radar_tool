import Link from 'next/link';
import { requirePermission } from '@/lib/auth/session';
import { isSupabaseServiceConfigured, getServiceSupabase } from '@/lib/supabase/server';
import { getAssignmentRules } from '@/lib/assignmentStore';
import { getUserProfiles } from '@/lib/auth/users';
import { can } from '@/lib/auth/roles';
import { listRoles, getPermissionCatalog } from '@/lib/auth/roleStore';
import RoleManager from '@/components/control/RoleManager';
import { Card, CardHeader, CardBody, EmptyState } from '@/components/ui';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import MigrationRequired from '@/components/MigrationRequired';
import AssignRunner from '@/components/control/AssignRunner';
import AssignmentEditor from '@/components/control/AssignmentEditor';
import RosterEditor from '@/components/control/RosterEditor';
import { getRoster } from '@/lib/assignmentStore';
import UserTable from '@/components/control/UserTable';
import InviteUserForm from '@/components/control/InviteUserForm';
import SignInAccess from '@/components/control/SignInAccess';
import { getAuthSettings } from '@/lib/auth/authSettings';
import { loadApolloUsers, territoriesFor } from '@/lib/export/apolloUsers';
import { suggestRoster } from '@/lib/export/apolloRoles';
import { getEnrichmentPolicy } from '@/lib/policies';
import SetupChecklist, { type SetupState } from '@/components/control/SetupChecklist';

export const dynamic = 'force-dynamic';

/**
 * Everything between an ingested record and a contact in Apollo, in the order
 * it has to be done.
 *
 * It lives on this page because every prerequisite it checks is on this page:
 * the roster, the rules that reach it, and the people who receive the work.
 * Splitting the diagnosis from the things it diagnoses meant two screens to
 * fix one problem.
 *
 * The roster and the rules are read once by the page and passed in — this only
 * adds the counts.
 */
async function readSetupState(
  roster: Awaited<ReturnType<typeof getRoster>>['rows'],
  assignmentRules: Awaited<ReturnType<typeof getAssignmentRules>>['rules']
): Promise<SetupState> {
  const service = isSupabaseServiceConfigured() ? getServiceSupabase() : null;

  /** A head-only count of `canonical_projects` under one column predicate. */
  const count = async (
    filter?: { column: string; op: 'eq'; value: string | boolean } | { column: string; op: 'notNull' }
  ): Promise<number> => {
    if (!service) return 0;
    let q = service.from('canonical_projects').select('id', { count: 'exact', head: true });
    if (filter?.op === 'eq') q = q.eq(filter.column, filter.value);
    else if (filter?.op === 'notNull') q = q.not(filter.column, 'is', null);
    const { count: n } = await q;
    return n ?? 0;
  };

  const [{ config: policy }] = await Promise.all([getEnrichmentPolicy()]);

  /*
    Eleven counts, one scan.

    These were ten parallel `count: 'exact', head: true` queries plus an eleventh in
    getTeamLoad. Measured against 111,353 rows: the UNFILTERED count(*) alone was
    9.4 s cold and 7.6 s warm, the unassigned count 6.7 s, and all ten in parallel
    9.7 s — barely better than the single worst, because ten queries scanning the same
    table contend for the same buffers. The filtered ones are cheap; count(*) with no
    predicate has to visit every tuple and no index shortcuts it.

    setup_state_rollup() does the lot in one pass with FILTER clauses, and the
    yardstick for expecting that to work was already in the repo: pipeline_rollup
    computes a full grouped aggregate in 1.5 s, six times faster than one unfiltered
    count. The database was never slow — the page was asking eleven times.
  */
  const rollup = service ? await service.rpc('setup_state_rollup').maybeSingle() : null;
  const r = rollup?.data as Record<string, number> | null | undefined;

  let total: number, scored: number, routed: number, enriched: number, assigned: number;
  let exported: number, withPhone: number, withEmail: number, verified: number, queued: number;

  if (r) {
    total = Number(r.total ?? 0);
    scored = Number(r.scored ?? 0);
    routed = Number(r.routed ?? 0);
    enriched = Number(r.enriched ?? 0);
    assigned = Number(r.assigned ?? 0);
    exported = Number(r.exported ?? 0);
    withPhone = Number(r.with_phone ?? 0);
    withEmail = Number(r.with_email ?? 0);
    verified = Number(r.verified ?? 0);
    queued = Number(r.queued ?? 0);
  } else {
    /*
      The migration is not applied yet, so fall back to the eleven queries.

      Same shape as summarise_pipeline's rollup fallback: a slow correct page beats
      `migration_required` on a screen whose job is to show whether setup is
      complete, and the branch disappears once the function exists.
    */
    [total, scored, routed, enriched, assigned, exported, withPhone, withEmail, verified, queued] =
      await Promise.all([
        count(),
        count({ column: 'priority_band', op: 'notNull' }),
        count({ column: 'route', op: 'notNull' }),
        count({ column: 'status', op: 'eq', value: 'ENRICHED' }),
        count({ column: 'assignee_id', op: 'notNull' }),
        count({ column: 'apollo_exported_at', op: 'notNull' }),
        count({ column: 'contact_phone', op: 'notNull' }),
        count({ column: 'contact_email', op: 'notNull' }),
        count({ column: 'email_verified', op: 'eq', value: true }),
        count({ column: 'status', op: 'eq', value: 'PENDING_ENRICHMENT' }),
      ]);
  }

  const receiving = roster.filter((r) => r.is_active);
  const targetedRoles = new Set(assignmentRules.filter((r) => r.toRole).map((r) => r.toRole as string));
  const targetedIds = new Set(assignmentRules.filter((r) => r.toUserId).map((r) => r.toUserId as string));

  return {
    counts: { total, scored, routed, queued, enriched, assigned, exported },
    contacts: { withPhone, withEmail, verified },
    channelRules: policy.channelRules,
    // The policy endpoint replaces the whole document, so the client has to
    // send everything back — posting channelRules alone would reset the rest.
    policy: policy as unknown as Record<string, unknown>,
    roster: receiving.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role })),
    assignmentRules: assignmentRules.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled !== false,
      toRole: r.toRole ?? null,
      toUserId: r.toUserId ?? null,
    })),
    // Kept whole so the client can append a rule without dropping the others:
    // the rules endpoint upserts the entire list.
    rulesRaw: assignmentRules as unknown as Record<string, unknown>[],
    // Anyone active on the roster is reachable now: leads no authored rule claims
    // fall through to ROSTER_FALLBACK_RULE, which spreads them across the roster
    // by scope and quota. So this step asks "can work reach a person at all",
    // which a non-empty roster answers on its own — it no longer demands that
    // somebody hand-write a rule first.
    rulesCanReachSomeone:
      receiving.length > 0 || receiving.some((p) => targetedRoles.has(p.role) || targetedIds.has(p.id)),
    cronConfigured: Boolean(process.env.CRON_SECRET?.trim()),
  };
}

interface TeamLoad {
  assignedToday: number;
  openLeads: number;
  breached: number;
}

/**
 * Per-owner load, counted from the leads themselves rather than a stored
 * counter — a counter would need resetting nightly and would drift after any
 * manual reassignment.
 */
/** PostgREST refuses to return more than this many rows in one response. */
const PAGE = 1000;

async function getTeamLoad(): Promise<{
  byUser: Map<string, TeamLoad>;
  unassigned: number;
  tableMissing: boolean;
  truncated: boolean;
}> {
  const byUser = new Map<string, TeamLoad>();
  if (!isSupabaseServiceConfigured()) return { byUser, unassigned: 0, tableMissing: false, truncated: false };

  const OPEN = '("CONVERTED","LOST")';

  try {
    const service = getServiceSupabase();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const now = Date.now();

    // The unassigned pool is COUNTED, never enumerated. It used to be tallied by
    // fetching rows and incrementing under a `.limit(5000)` that PostgREST
    // silently clamps to its own max-rows of 1,000 — so the tile read exactly
    // "1,000" while 22,438 leads sat unowned, and would have read 1,000 at any
    // size above that. `head: true` asks for the count and no rows, so this stays
    // flat in transferred data however large the pool grows.
    /*
      The unassigned pool, from the same rollup the setup tiles use.

      Still COUNTED and never enumerated — the recorded bug here was tallying it by
      fetching rows under a `.limit(5000)` that PostgREST silently clamps to 1,000, so
      the tile read exactly "1,000" while 22,438 leads sat unowned. That lesson stands;
      this only changes WHERE the count happens. As its own `head: true` query it was
      6.7 s, because `status not in (…)` cannot use an index well; folded into
      setup_state_rollup it is one FILTER clause on a scan that was happening anyway.
    */
    const rollup = await service.rpc('setup_state_rollup').maybeSingle();
    let unassigned: number;

    if (rollup.data) {
      unassigned = Number((rollup.data as Record<string, number>).unassigned_open ?? 0);
    } else {
      // Migration not applied: the original query, with its original predicate.
      const { count, error: countError } = await service
        .from('canonical_projects')
        .select('id', { count: 'exact', head: true })
        .not('status', 'in', OPEN)
        .is('owner_user_id', null);

      if (countError) {
        return {
          byUser,
          unassigned: 0,
          tableMissing: /does not exist|schema cache/i.test(countError.message),
          truncated: false,
        };
      }
      unassigned = count ?? 0;
    }

    // Assigned rows genuinely need row-level detail — `owner_assigned_at` for
    // today's tally, `sla_due_at` for a deadline nobody has recomputed — so they
    // are paged rather than capped. That set is bounded by what the team is
    // working, not by the size of the table.
    let truncated = false;
    const MAX_PAGES = 50;
    for (let p = 0; p < MAX_PAGES; p++) {
      const from = p * PAGE;
      const { data, error } = await service
        .from('canonical_projects')
        .select('owner_user_id, owner_assigned_at, sla_due_at, sla_breached')
        .not('status', 'in', OPEN)
        .not('owner_user_id', 'is', null)
        // Ordered so the pages are stable. Each `.range()` is its own query, and
        // without a sort Postgres may order them differently per page — repeating
        // some rows and skipping others, which would silently miscount load.
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);

      if (error) break;
      const rows = (data ?? []) as Record<string, unknown>[];

      for (const r of rows) {
        const owner = r.owner_user_id as string;
        const entry = byUser.get(owner) ?? { assignedToday: 0, openLeads: 0, breached: 0 };
        entry.openLeads += 1;
        if (r.owner_assigned_at && new Date(r.owner_assigned_at as string) >= midnight) entry.assignedToday += 1;
        // Breached counts both the stored flag and a deadline that has simply
        // passed without anyone recomputing it.
        if (r.sla_breached || (r.sla_due_at && new Date(r.sla_due_at as string).getTime() < now)) entry.breached += 1;
        byUser.set(owner, entry);
      }

      if (rows.length < PAGE) break;
      // Hit the ceiling with a full page still coming: say so rather than
      // quietly reporting a partial tally as the whole truth.
      if (p === MAX_PAGES - 1) truncated = true;
    }

    return { byUser, unassigned, tableMissing: false, truncated };
  } catch {
    return { byUser, unassigned: 0, tableMissing: true, truncated: false };
  }
}

export default async function TeamPage() {
  const me = await requirePermission('leads.reassign', '/control/team');

  if (!isSupabaseServiceConfigured()) {
    return (
      <div>
        <SupabaseNotConfigured detail="The team view needs the Supabase service role key." />
      </div>
    );
  }

  const [
    { users, tableMissing: usersMissing },
    { byUser, unassigned, tableMissing: leadsMissing, truncated: loadTruncated },
    assignment,
  ] = await Promise.all([getUserProfiles(), getTeamLoad(), getAssignmentRules()]);
  const { rules: assignmentRules, isDefault } = assignment;
  const roster = await getRoster();
  const authSettings = await getAuthSettings();
  const setupState = await readSetupState(roster.rows, assignmentRules);

  // Resolved here rather than in the browser: the roster editor needs it on
  // first paint, and loadApolloUsers caches per process so this is one call
  // per server lifetime, not one per page view.
  const onRoster = new Set(roster.rows.filter((r) => r.email).map((r) => r.email!.trim().toLowerCase()));
  const apolloRaw = (await loadApolloUsers()).filter((u) => {
    const name = (u.name ?? `${u.first_name ?? ''} ${u.last_name ?? ''}`).trim();
    const email = (u.email ?? '').trim().toLowerCase();
    // Without both halves a lead owned by them could never be matched back on
    // export, so offering them would only create a roster entry that is ignored.
    return name && email && !/@fake\.com$/i.test(email) && !onRoster.has(email);
  });

  // Apollo already knows each person's job title and prospect territory, which
  // are the two things the roster would otherwise ask an admin to retype.
  const apolloUsers = (
    await Promise.all(
      apolloRaw.map(async (u) => {
        const terr = await territoriesFor(u);
        const suggestion = suggestRoster({ title: u.title, territories: terr });
        return {
          name: (u.name ?? `${u.first_name ?? ''} ${u.last_name ?? ''}`).trim(),
          email: (u.email ?? '').trim().toLowerCase(),
          title: u.title ?? null,
          territories: terr,
          role: suggestion.role,
          bu: suggestion.bu,
          because: suggestion.because,
        };
      })
    )
  ).sort((a, b) => a.name.localeCompare(b.name));

  if (usersMissing || leadsMissing) {
    return (
      <div>
        <h1 className="text-foreground mb-6 text-2xl font-bold">Team</h1>
        <MigrationRequired feature="The team view" />
      </div>
    );
  }

  // Sellers only — an admin who never receives leads would skew the load view.
  const sellers = users.filter((u) => u.isActive && ['bdr', 'sdr', 'ae', 'marketing'].includes(u.role));
  const team = sellers.map((u) => {
    const load = byUser.get(u.id) ?? { assignedToday: 0, openLeads: 0, breached: 0 };
    return {
      id: u.id,
      name: u.fullName || u.email || 'Unnamed',
      role: u.role,
      assignedToday: load.assignedToday,
      dailyQuota: 50,
      openLeads: load.openLeads,
      breached: load.breached,
    };
  });

  const canManageUsers = can(me, 'users.manage');

  /*
    The roles an admin may hand out, read from the table rather than from a
    constant — a role somebody defines is useless if the picker cannot offer it.
  */
  const [{ roles: roleList }, permissionCatalog] = await Promise.all([listRoles(), getPermissionCatalog()]);

  return (
    <div>
      <h1 className="text-foreground text-2xl font-bold">Team</h1>
      <p className="text-muted mb-6 mt-1 max-w-3xl text-sm">
        Who is on the team, what they hold, and where the load sits. Assignment follows the rules; anything left
        unassigned is visible to everyone whose scope covers it.
      </p>

      {canManageUsers ? (
        <section className="mb-10">
          <h2 className="text-foreground text-lg font-semibold">Get started</h2>
          <p className="text-muted mb-4 mt-1 max-w-3xl text-sm">
            Each stage feeds the next, so a stoppage anywhere shows up as an empty result everywhere downstream —
            &ldquo;the export found nothing&rdquo; is almost never about the export. This checks every link, in order,
            and puts the fix next to the finding.
          </p>
          <SetupChecklist state={setupState} />
        </section>
      ) : null}

      {/*
        The four-tile summary that used to sit here is gone. Three of its numbers
        were sums over the seller list, so they read zero whenever nobody holds a
        seller role — which said more about the roster than about the work — and
        the fourth, the unassigned count, is stated where it is actionable: on the
        Unassigned pool card below, next to the link that opens those leads.
      */}
      {loadTruncated ? (
        <p className="text-warning mb-8 text-xs">
          More assigned leads than this view counts — the per-seller figures below are a partial tally, not the whole
          book.
        </p>
      ) : null}

      {/*
        Assignment, in one place and in use order: who can receive, what routes
        where, then run it.

        These were three separate surfaces, and two of them were duplicated in the
        setup checklist — a second roster with its own Apollo picker, and a second
        "Run assignment" button posting the same autoAssign. A lead is assigned
        once, by one pass, so there is one place to set it up and one button to
        fire it. The checklist reports whether it is working; it no longer carries
        its own copies.
      */}
      <section className="mb-10">
        <h2 className="text-foreground text-lg font-semibold">Assignment</h2>
        <p className="text-muted mb-4 mt-1 max-w-3xl text-sm">
          A lead gets an owner once. Everyone on the roster receives by their own scope and quota — rules are only for
          sending particular leads somewhere particular.
        </p>

        <div className="space-y-4">
          {canManageUsers ? (
            <RosterEditor
              rows={roster.rows.map((r) => ({ ...r, openLeads: byUser.get(r.id)?.openLeads ?? 0 }))}
              tableMissing={roster.tableMissing}
              apolloUsers={apolloUsers}
            />
          ) : null}

          {canManageUsers ? (
            <AssignmentEditor
              initialRules={assignmentRules}
              isDefault={isDefault}
              unassigned={unassigned}
              // The roster, not the app's user accounts — a rule must be able to
              // target someone who has never logged in.
              users={roster.rows.map((r) => ({
                id: r.id,
                name: r.name,
                role: r.role,
                bu: r.bu ?? [],
                verticals: r.verticals ?? [],
                regions: r.regions ?? [],
                isActive: r.is_active,
              }))}
            />
          ) : null}

          <AssignRunner team={team} isDefaultRules={isDefault} />
        </div>
      </section>

      <Card>
        <CardHeader
          title="Unassigned pool"
          subtitle={`${unassigned.toLocaleString()} lead${unassigned === 1 ? '' : 's'} with no owner`}
          action={
            <Link href="/records?mine=0&owner=none" className="text-brand text-xs underline">
              View them
            </Link>
          }
        />
        <CardBody>
          {unassigned === 0 ? (
            <EmptyState title="Everything has an owner" description="No leads are waiting for assignment." />
          ) : (
            <p className="text-muted text-sm">
              These matched no assignment rule, or every eligible owner was at quota when the pass ran. Run assignment
              again after raising quotas, or hand them out directly from the records table.
            </p>
          )}
        </CardBody>
      </Card>

      {canManageUsers ? (
        <div className="mt-8 space-y-6">
          <div>
            <h2 className="text-foreground text-lg font-semibold">Members &amp; roles</h2>
            <p className="text-muted mt-1 max-w-3xl text-sm">
              A role decides which leads someone sees and which parts of the Control Center they can open. Changes take
              effect on their next request.
            </p>
          </div>

          <SignInAccess
            domains={authSettings.allowedDomains}
            pending={users
              .filter((u) => !u.isActive)
              .map((u) => ({ id: u.id, email: u.email, fullName: u.fullName }))}
            tableMissing={authSettings.tableMissing}
          />

          <Card>
            <CardHeader
              title="Roles"
              subtitle="What each role may do. Create your own — permissions are the checks the code enforces"
            />
            <CardBody>
              <RoleManager roles={roleList} permissions={permissionCatalog} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={`Members (${users.length})`} subtitle="Everyone with access, sellers and staff alike" />
            {users.length === 0 ? (
              <CardBody>
                <EmptyState title="No users yet" description="Grant someone access below, or let them sign in with Google." />
              </CardBody>
            ) : (
              <UserTable users={users} currentUserId={me.id} roles={roleList} />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Grant access ahead of time"
              subtitle="Sets their role now, so their first Google sign-in lands with it — nothing is emailed"
            />
            <CardBody>
              <InviteUserForm roles={roleList} />
            </CardBody>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
