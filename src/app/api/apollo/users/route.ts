import { NextResponse } from 'next/server';
import { checkPermission } from '@/lib/auth/session';
import { loadApolloUsers } from '@/lib/export/apolloUsers';
import { getRoster } from '@/lib/assignmentStore';

export const dynamic = 'force-dynamic';

/**
 * GET /api/apollo/users — everyone in the Apollo workspace, and whether they
 * are already on the roster.
 *
 * The roster is what assignment reads; Apollo is where the contact ends up
 * owned. Keeping the two in step by hand means retyping addresses, and a typo
 * there is silent — the export simply attaches no owner.
 */
export async function GET() {
  const auth = await checkPermission('users.manage');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  const [users, roster] = await Promise.all([loadApolloUsers(true), getRoster()]);

  const onRoster = new Set(
    roster.rows.filter((r) => r.email).map((r) => r.email!.trim().toLowerCase())
  );

  const rows = users
    .map((u) => ({
      name: (u.name ?? `${u.first_name ?? ''} ${u.last_name ?? ''}`).trim(),
      email: (u.email ?? '').trim().toLowerCase(),
    }))
    // A record with no name or no address cannot be matched back from a lead,
    // so offering it would only create a roster entry the export ignores.
    .filter((u) => u.name && u.email && !/@fake\.com$/i.test(u.email))
    .map((u) => ({ ...u, onRoster: onRoster.has(u.email) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({
    ok: true,
    users: rows,
    skipped: users.length - rows.length,
    message: rows.length === 0 ? 'Apollo returned no usable users — check the API key in Settings.' : undefined,
  });
}
