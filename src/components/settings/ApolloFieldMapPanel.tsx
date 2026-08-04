'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardBody, Badge, Button, controlClass } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

/**
 * Where each of our fields is written in Apollo.
 *
 * This exists because the built-in mapping cannot be right for every workspace and
 * two of its seven entries are already wrong for this one: `Qualify Account` and
 * `evercam_us_project_signal` are modality 'account', so Apollo accepts them on a
 * contact and silently discards them. The ICP score, trigger event and pain point
 * were "sent" on every export and never arrived, and no code change fixes that —
 * only somebody who knows which contact-level field should hold that text.
 *
 * The dropdown offers ONLY fields a contact write can land in: contact modality,
 * free-text type. A picklist would reject the whole contact, and an account-level
 * field would accept it and drop it — neither belongs in a list of choices.
 */

export interface ApolloFieldOption {
  name: string;
  type: string;
  /** Apollo's hard character ceiling, when it has one. */
  maxLength: number | null;
}

export interface ApolloFieldSource {
  source: string;
  /** What this field is, in the words the export uses. */
  describe: string;
  /** The built-in target, so a changed row can be seen to have changed. */
  defaultTarget: string | null;
  /** The saved target, or the default when nothing is saved. */
  current: string | null;
  /**
   * Set when the CURRENT target cannot receive a contact write — the whole reason
   * this panel exists. Carries the modality that owns it.
   */
  brokenModality: string | null;
}

export default function ApolloFieldMapPanel({
  sources,
  options,
  isDefault,
  apolloConfigured,
}: {
  sources: ApolloFieldSource[];
  options: ApolloFieldOption[];
  isDefault: boolean;
  apolloConfigured: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [map, setMap] = useState<Record<string, string | null>>(
    Object.fromEntries(sources.map((s) => [s.source, s.current]))
  );
  const [busy, setBusy] = useState(false);

  const dirty = sources.some((s) => (map[s.source] ?? null) !== (s.current ?? null));

  // Two of our fields pointing at one Apollo field means the second overwrites
  // the first. Caught here so the reason is visible next to the rows that clash,
  // not only in the save response.
  const counts = new Map<string, number>();
  for (const t of Object.values(map)) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  const clashing = new Set([...counts.entries()].filter(([, n]) => n > 1).map(([t]) => t));

  async function save() {
    setBusy(true);
    try {
      const res = await fetch('/api/policy/export-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: map }),
      });
      const json = await res.json();
      toast.show(json.message, json.ok ? 'success' : 'error');
      if (json.ok) router.refresh();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setMap(Object.fromEntries(sources.map((s) => [s.source, s.defaultTarget])));
  }

  const broken = sources.filter((s) => s.brokenModality);

  return (
    <Card>
      <CardHeader
        title="Apollo field mapping"
        subtitle="Which Apollo custom field each exported field is written into"
        action={
          <div className="flex items-center gap-2">
            {isDefault ? <Badge tone="neutral">built-in defaults</Badge> : <Badge tone="info">customised</Badge>}
            <Button size="sm" variant="ghost" onClick={reset} disabled={busy}>
              Reset to defaults
            </Button>
            <Button size="sm" variant="primary" onClick={save} disabled={busy || !dirty || clashing.size > 0}>
              {busy ? 'Saving…' : 'Save mapping'}
            </Button>
          </div>
        }
      />
      <CardBody>
        {!apolloConfigured ? (
          <p className="text-warning mb-4 text-sm">
            No Apollo API key is configured, so the workspace&rsquo;s custom fields could not be listed. Add the key
            above and reload — until then there is nothing to choose from.
          </p>
        ) : null}

        {broken.length > 0 ? (
          <div className="border-l-warning bg-surface-raised mb-4 border-l-4 px-3 py-2">
            <p className="text-foreground text-sm font-medium">
              {broken.length} field{broken.length === 1 ? '' : 's'} currently write nowhere
            </p>
            <p className="text-muted mt-1 text-xs">
              {broken.map((s) => `"${s.current}" is ${s.brokenModality}-level`).join('; ')}. Apollo accepts these on a
              contact and discards them, so the content never arrives. Point them at a contact-level field below, or set
              them to <span className="font-mono">Do not write</span> so the export stops claiming to send them.
            </p>
          </div>
        ) : null}

        <div className="divide-border-base divide-y">
          {sources.map((s) => {
            const target = map[s.source] ?? null;
            const chosen = options.find((o) => o.name === target);
            const changed = target !== (s.current ?? null);
            // A target that is set but absent from the options is either a stale
            // name or a non-contact field. Either way the write cannot land, and
            // hiding it would make the row look healthy.
            const unusable = Boolean(target) && !chosen;

            return (
              <div key={s.source} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 sm:w-72 sm:shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground font-mono text-xs">{s.source}</span>
                    {changed ? <Badge tone="brand">changed</Badge> : null}
                  </div>
                  <p className="text-muted text-xs">{s.describe}</p>
                </div>

                <div className="flex flex-1 flex-wrap items-center gap-2">
                  <select
                    aria-label={`Apollo field for ${s.source}`}
                    className={controlClass}
                    value={target ?? ''}
                    disabled={busy}
                    onChange={(e) => setMap((m) => ({ ...m, [s.source]: e.target.value || null }))}
                  >
                    {/* An explicit, selectable "off" — the honest setting for a
                        field with no contact-level home. */}
                    <option value="">— Do not write —</option>
                    {/* A target that is currently set but unusable is kept in the
                        list so the row shows what it IS, not a blank. */}
                    {unusable ? <option value={target ?? ''}>{target} — cannot receive a write</option> : null}
                    {options.map((o) => (
                      <option key={o.name} value={o.name}>
                        {o.name}
                        {o.maxLength != null ? ` (max ${o.maxLength})` : ''}
                      </option>
                    ))}
                  </select>

                  {clashing.has(target ?? '') ? (
                    <Badge tone="danger">also used by another field</Badge>
                  ) : unusable ? (
                    <Badge tone="warning">writes nowhere</Badge>
                  ) : chosen?.maxLength != null ? (
                    <span className="text-subtle text-xs">truncated past {chosen.maxLength} chars</span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        {clashing.size > 0 ? (
          <p className="text-danger mt-4 text-xs">
            Two fields cannot share one Apollo field — the second write would overwrite the first. Give each its own
            field, or set one to <span className="font-mono">Do not write</span>.
          </p>
        ) : null}

        <p className="text-subtle mt-4 text-xs">
          Only contact-level free-text fields are offered: a picklist rejects the whole contact, and an account-level
          field accepts the value and drops it. Changes apply to the next export — contacts already in Apollo are not
          rewritten.
        </p>
      </CardBody>
    </Card>
  );
}
