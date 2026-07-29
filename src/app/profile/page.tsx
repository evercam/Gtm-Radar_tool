import { requireUser } from '@/lib/auth/session';
import { ROLE_LABELS, ROLE_DESCRIPTIONS, ROLE_PERMISSIONS } from '@/lib/auth/roles';
import { BU_LABELS, titleize } from '@/lib/semantics';
import { Card, CardHeader, CardBody, Badge, Stat } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const user = await requireUser('/profile');

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6 flex items-center gap-4">
        <div className="bg-brand text-brand-contrast flex h-14 w-14 items-center justify-center rounded-full text-lg font-semibold">
          {(user.fullName || user.email || '??').slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <h1 className="text-foreground truncate text-2xl font-bold">{user.fullName || user.email}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone="brand">{ROLE_LABELS[user.role]}</Badge>
            <Badge tone={user.isActive ? 'success' : 'neutral'}>{user.isActive ? 'Active' : 'Disabled'}</Badge>
          </div>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Business units"
          value={user.bu.length || 'All'}
          note={user.bu.map((b) => BU_LABELS[b] ?? b).join(', ') || 'no restriction'}
        />
        <Stat
          label="Verticals"
          value={user.verticals.length || 'All'}
          note={user.verticals.length ? user.verticals.map(titleize).join(', ') : 'no restriction'}
        />
        <Stat label="Regions" value={user.regions.length || 'All'} note={user.regions.join(', ') || 'no restriction'} />
        <Stat
          label="Onboarded"
          value={user.onboardedAt ? 'Yes' : 'No'}
          note={user.onboardedAt ? new Date(user.onboardedAt).toLocaleDateString() : 'pending'}
        />
      </div>

      <Card>
        <CardHeader title="What your role can do" subtitle={ROLE_DESCRIPTIONS[user.role]} />
        <CardBody>
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {ROLE_PERMISSIONS[user.role].map((p) => (
              <li key={p} className="text-muted flex items-center gap-2 text-sm">
                <span className="text-success">✓</span>
                <code className="text-xs">{p}</code>
              </li>
            ))}
          </ul>
          <p className="text-subtle mt-4 text-xs">
            Scope and role are set by an administrator. Ask a Sales Manager or Admin if these need to change.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
