'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';
import { Badge, Button, Card, CardBody, CardHeader, Label, controlClass } from '@/components/ui';

/**
 * The domain allow-list, and whoever is currently waiting because of it.
 *
 * Presented together on purpose: the list is only comprehensible next to its
 * consequence, and an admin who has just added a domain usually has someone
 * pending on exactly that domain.
 */
export default function SignInAccess({
  domains,
  pending,
  tableMissing,
}: {
  domains: string[];
  pending: { id: string; email: string | null; fullName: string | null }[];
  tableMissing: boolean;
}) {
  const router = useRouter();
  const [list, setList] = useState(domains);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const dirty = list.join(',') !== domains.join(',');

  function add() {
    const value = draft.trim().toLowerCase().replace(/^@+/, '');
    if (!value || list.includes(value)) {
      setDraft('');
      return;
    }
    setList([...list, value].sort());
    setDraft('');
  }

  async function save() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/auth/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedDomains: list }),
      });
      const json = await res.json();
      setResult({ ok: json.ok !== false, message: json.message ?? `HTTP ${res.status}` });
      if (json.ok !== false) router.refresh();
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (tableMissing) {
    return (
      <Card>
        <CardHeader title="Sign-in access" />
        <CardBody>
          <p className="text-muted text-sm">
            Run the <code className="font-mono">20260729100000_google_oauth</code> migration to control which domains
            may sign in.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Sign-in access"
        subtitle="Google sign-in is open to anyone with a Google account — this decides who it lets through"
      />
      <CardBody>
        <div className="flex flex-wrap items-center gap-2">
          {list.length === 0 ? (
            <p className="text-muted text-sm">
              No domains listed. Every new account arrives disabled and waits for someone here to enable it.
            </p>
          ) : (
            list.map((d) => (
              <span
                key={d}
                className="border-border-base bg-surface-raised text-foreground inline-flex items-center gap-1.5 rounded-full border py-1 pl-3 pr-1.5 text-xs font-medium"
              >
                @{d}
                <button
                  type="button"
                  onClick={() => setList(list.filter((x) => x !== d))}
                  aria-label={`Remove ${d}`}
                  className="text-muted hover:text-danger rounded-full p-0.5"
                >
                  <X size={12} strokeWidth={2.5} />
                </button>
              </span>
            ))
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block">
            <Label hint="the part after the @">Add a domain</Label>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="evercam.com"
              className={`${controlClass} w-56`}
            />
          </label>
          <Button size="sm" onClick={add} disabled={!draft.trim()} className="flex items-center gap-1.5">
            <Plus size={12} strokeWidth={2.4} />
            Add
          </Button>
          <Button size="sm" variant="primary" onClick={save} disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>

        {result ? (
          <p className={`mt-3 text-xs ${result.ok ? 'text-success' : 'text-danger'}`}>{result.message}</p>
        ) : null}

        <p className="text-subtle mt-3 text-[11px]">
          Existing accounts are unaffected — removing a domain never disables anyone, it only stops the next new
          address from admitting itself.
        </p>

        {pending.length > 0 ? (
          <div className="border-border-base mt-5 border-t pt-4">
            <div className="flex items-center gap-2">
              <p className="text-foreground text-[13px] font-bold">Waiting for approval</p>
              <Badge tone="warning">{pending.length}</Badge>
            </div>
            <p className="text-muted mt-1 text-xs">
              They signed in successfully but their domain is not listed. Enable them in Members below.
            </p>
            <ul className="mt-2 space-y-1">
              {pending.map((p) => (
                <li key={p.id} className="text-body text-xs">
                  {p.fullName ? `${p.fullName} — ` : ''}
                  <span className="font-mono">{p.email ?? 'no address'}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
