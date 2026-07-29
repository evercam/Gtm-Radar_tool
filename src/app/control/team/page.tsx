import Link from 'next/link';
import { requirePermission } from '@/lib/auth/session';
import { isSupabaseServiceConfigured, getServiceSupabase } from '@/lib/supabase/server';
import { getAssignmentRules } from '@/lib/assignmentStore';
import { getUserProfiles } from '@/lib/auth/users';
import { ROLE_LABELS, can, type Role } from '@/lib/auth/roles';
import { Card, CardHeader, CardBody, Stat, EmptyState } from '@/components/ui';
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

  const [total, scored, routed, enriched, assigned, exported, withPhone, withEmail, verified, queued] =
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
    rulesCanReachSomeone: receiving.some((p) => targetedRoles.has(p.role) || targetedIds.has(p.id)),
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
async function getTeamLoad(): Promise<{ byUser: Map<string, TeamLoad>; unassigned: number; tableMissing: boolean }> {
  const byUser = new Map<string, TeamLoad>();
  if (!isSupabaseServiceConfigured()) return { byUser, unassigned: 0, tableMissing: false };

  try {
    const service = getServiceSupabase();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    const { data, error } = await service
      .from('canonical_projects')
      .select('owner_user_id, owner_assigned_at, sla_due_at, sla_breached, status')
      .not('status', 'in', '("CONVERTED","LOST")')
      .limit(5000);

    if (error) {
      return { byUser, unassigned: 0, tableMissing: /does not exist|schema cache/i.test(error.message) };
    }

    let unassigned = 0;
    const now = Date.now();

    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const owner = r.owner_user_id as string | null;
      if (!owner) {
        unassigned += 1;
        continue;
      }
      const entry = byUser.get(owner) ?? { assignedToday: 0, openLeads: 0, breached: 0 };
      entry.openLeads += 1;
      if (r.owner_assigned_at && new Date(r.owner_assigned_at as string) >= midnight) entry.assignedToday += 1;
      // Breached counts both the stored flag and a deadline that has simply
      // passed without anyone recomputing it.
      if (r.sla_breached || (r.sla_due_at && new Date(r.sla_due_at as string).getTime() < now)) entry.breached += 1;
      byUser.set(owner, entry);
    }

    return { byUser, unassigned, tableMissing: false };
  } catch {
    return { byUser, unassigned: 0, tableMissing: true };
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

  const [{ users, tableMissing: usersMissing }, { byUser, unassigned, tableMissing: leadsMissing }, assignment] =
    await Promise.all([getUserProfiles(), getTeamLoad(), getAssignmentRules()]);
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
      role: ROLE_LABELS[u.role as Role] ?? u.role,
      assignedToday: load.assignedToday,
      dailyQuota: 50,
      openLeads: load.openLeads,
      breached: load.breached,
    };
  });

  const canManageUsers = can(me.role, 'users.manage');
  const totalOpen = team.reduce((s, m) => s + m.openLeads, 0);
  const totalBreached = team.reduce((s, m) => s + m.breached, 0);

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

      <section className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sellers" value={team.length} note="active and receiving" />
        <Stat label="Open leads" value={totalOpen.toLocaleString()} note="assigned and unresolved" />
        <Stat
          label="Unassigned"
          value={unassigned.toLocaleString()}
          note="waiting for an owner"
          tone={unassigned > 0 ? 'warning' : undefined}
        />
        <Stat
          label="Past SLA"
          value={totalBreached.toLocaleString()}
          note="need attention now"
          tone={totalBreached > 0 ? 'danger' : undefined}
        />
      </section>

      <div className="mb-8">
        <AssignRunner team={team} isDefaultRules={isDefault} />
      </div>

      {canManageUsers ? (
        <div className="mb-8">
          <RosterEditor
            rows={roster.rows.map((r) => ({ ...r, openLeads: byUser.get(r.id)?.openLeads ?? 0 }))}
            tableMissing={roster.tableMissing}
            apolloUsers={apolloUsers}
          />
        </div>
      ) : null}

      {canManageUsers ? (
        <div className="mb-8">
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
        </div>
      ) : null}

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
            <CardHeader title={`Members (${users.length})`} subtitle="Everyone with access, sellers and staff alike" />
            {users.length === 0 ? (
              <CardBody>
                <EmptyState title="No users yet" description="Grant someone access below, or let them sign in with Google." />
              </CardBody>
            ) : (
              <UserTable users={users} currentUserId={me.id} />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Grant access ahead of time"
              subtitle="Sets their role now, so their first Google sign-in lands with it — nothing is emailed"
            />
            <CardBody>
              <InviteUserForm />
            </CardBody>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
