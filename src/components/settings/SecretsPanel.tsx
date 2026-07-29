'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SecretStatus } from '@/lib/crypto/store';
import { Card, CardHeader, CardBody, Badge, Button } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

/**
 * Platform API keys. Values are write-only: the server never returns a stored
 * key, so an input left blank means "leave it unchanged" and the panel shows
 * only a last-4 hint.
 */
export default function SecretsPanel({
  statuses,
  keyId,
  tableMissing,
}: {
  statuses: SecretStatus[];
  keyId: string | null;
  tableMissing: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function post(payload: Record<string, unknown>, busyKey: string) {
    setBusy(busyKey);
    try {
      const res = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      toast.show(json.message, json.ok ? 'success' : 'error');
      if (json.ok) {
        setValues((v) => ({ ...v, [String(payload.key ?? '')]: '' }));
        router.refresh();
      }
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  const inEnv = statuses.filter((s) => s.origin === 'env');
  const stale = statuses.filter((s) => s.stale);

  return (
    <Card>
      <CardHeader
        title="Platform API keys"
        subtitle={keyId ? `Encrypted with AES-256-GCM · active key ${keyId}` : 'No encryption key available'}
        action={
          <div className="flex gap-2">
            {inEnv.length > 0 ? (
              <Button size="sm" onClick={() => post({ action: 'import' }, 'import')} disabled={busy !== null}>
                {busy === 'import' ? 'Importing…' : `Import ${inEnv.length} from env`}
              </Button>
            ) : null}
            {stale.length > 0 ? (
              <Button size="sm" onClick={() => post({ action: 'reencrypt' }, 'reencrypt')} disabled={busy !== null}>
                {busy === 'reencrypt' ? 'Re-encrypting…' : 'Re-encrypt'}
              </Button>
            ) : null}
          </div>
        }
      />
      <CardBody>
        {tableMissing ? (
          <p className="text-warning text-sm">
            The <code className="font-mono text-xs">app_secrets</code> table does not exist yet — run the
            encrypted_secrets migration. Keys are still read from the environment until then.
          </p>
        ) : null}

        {inEnv.length > 0 ? (
          <p className="text-muted mb-4 text-xs">
            {inEnv.length} key{inEnv.length === 1 ? '' : 's'} still live in environment variables. Import them to store
            them encrypted, then remove the variables.
          </p>
        ) : null}

        <div className="divide-border-base divide-y">
          {statuses.map((s) => (
            <div key={s.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 sm:w-64 sm:shrink-0">
                <div className="flex items-center gap-2">
                  <span className="text-foreground text-sm font-medium">{s.label}</span>
                  {s.required ? <Badge tone="danger">required</Badge> : null}
                </div>
                <p className="text-muted text-xs">{s.description}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={s.isSet ? 'success' : s.required ? 'danger' : 'neutral'}>
                    {s.isSet ? `Set ${s.last4 ?? ''}`.trim() : 'Not set'}
                  </Badge>
                  {s.origin === 'env' ? <Badge tone="warning">from env</Badge> : null}
                  {s.origin === 'database' ? <Badge tone="info">encrypted</Badge> : null}
                  {s.stale ? <Badge tone="warning">old key</Badge> : null}
                </div>
              </div>

              <div className="flex flex-1 items-center gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={s.isSet ? 'Replace key — leave blank to keep' : 'Paste key'}
                  value={values[s.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.value }))}
                  className="border-border-strong bg-surface text-foreground w-full rounded-lg border px-3 py-2 text-sm"
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy !== null || !(values[s.key] ?? '').trim()}
                  onClick={() => post({ action: 'save', key: s.key, value: values[s.key] }, s.key)}
                >
                  {busy === s.key ? 'Saving…' : 'Save'}
                </Button>
                {s.origin === 'database' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => post({ action: 'save', key: s.key, value: '' }, s.key)}
                    title="Remove the stored key"
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <p className="text-subtle mt-4 text-xs">
          Keys are encrypted with AES-256-GCM before they reach the database and are never sent back to the browser —
          only the last four characters are shown.
        </p>
      </CardBody>
    </Card>
  );
}
