import { isSupabaseServerConfigured } from '@/lib/supabase/server';
import { cn } from '@/lib/cn';
import { badgeTone } from '@/lib/status-colors';
import { Badge } from '@/components/ui';
import { getMaskedCredentials } from '@/lib/settingsData';
import { SOURCE_CATALOG } from '@/lib/sourceCatalog';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import CredentialForm from '@/components/settings/CredentialForm';
import TestConnectionButton from '@/components/settings/TestConnectionButton';
import SecretsPanel from '@/components/settings/SecretsPanel';
import ApolloFieldMapPanel from '@/components/settings/ApolloFieldMapPanel';
import ConfigExport from '@/components/settings/ConfigExport';
import { SOURCE_SLUGS } from '@/lib/sourceSlugs';
import { getSecretStatuses } from '@/lib/crypto/store';
import { activeKeyId } from '@/lib/crypto/secrets';
import { requirePermission } from '@/lib/auth/session';
import { loadCustomFields, FIELD_MAP } from '@/lib/export/apolloFields';
import { getExportFieldPolicy } from '@/lib/policies';
import { DEFAULT_EXPORT_FIELD_POLICY } from '@/lib/export/fieldPolicy';
import { listTokens } from '@/lib/auth/apiTokens';
import { listConnections } from '@/lib/auth/oauth/tokens';
import { getRoles } from '@/lib/auth/roleStore';
import TokenManager from '@/components/settings/TokenManager';
import ConnectionManager from '@/components/settings/ConnectionManager';

export const dynamic = 'force-dynamic';



export default async function SettingsPage() {
  await requirePermission('settings.manage', '/admin/settings');

  const supabaseOn = isSupabaseServerConfigured();

  // Tokens for the HTTP MCP endpoint. A token carries a role, so the picker
  // needs the live role list rather than a hard-coded six.
  // Connections are the other half: not minted here, but created when somebody
  // approves a client on the consent screen. Read alongside the tokens so the two
  // ways in are visible together rather than in separate corners of the app.
  const [{ tokens, tableMissing: tokensMissing }, { roles: allRoles }, { connections, tableMissing: connectionsMissing }] =
    await Promise.all([listTokens(), getRoles(), listConnections()]);
  const tokenRoles = allRoles.map((r) => ({ name: r.name, label: r.label }));

  // The policies moved to the pages that run them: scoring to /control/routing
  // next to the bands it produces, enrichment to /control/enrichment next to
  // the spend it governs. Settings keeps the keys.
  const secrets = await getSecretStatuses();

  // Credential forms are driven by SOURCE_CATALOG, the same static catalog
  // /sources renders from. They used to read the `source_registry` table,
  // which was retired with the single-table model — that query returns an
  // empty array, so this section silently rendered zero forms and no key
  // could be saved from the UI at all.
  //
  // Only keyed sources appear: the keyless ones (open gov/EU data, RSS, GEM
  // uploads) have nothing to configure.
  const keyedSources = SOURCE_CATALOG.filter((s) => s.auth === 'keyed');

  /*
    The Apollo field mapping, resolved against what the workspace actually has.

    The choices have to come from Apollo rather than a hardcoded list, because the
    whole failure this fixes is a mapping that no longer matches the workspace. Only
    contact-modality free-text fields are offered: a picklist rejects the entire
    contact, and an account-level field accepts the value and silently drops it.
  */
  const WRITABLE_TYPES = new Set(['string', 'textarea', 'text']);
  const allFields = await loadCustomFields();
  const fieldOptions = allFields
    .filter((f) => f.modality === 'contact' && WRITABLE_TYPES.has(f.type))
    .map((f) => ({ name: f.name, type: f.type, maxLength: f.maxLength }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Deduplicated by name: this workspace has two fields called "Project Name" and
  // a dropdown with the same label twice is a coin toss, not a choice.
  const uniqueFieldOptions = fieldOptions.filter((o, i) => fieldOptions.findIndex((x) => x.name === o.name) === i);

  const { config: savedFieldMap, isDefault: fieldMapIsDefault } = await getExportFieldPolicy();
  const fieldSources = FIELD_MAP.map((f) => {
    const current = savedFieldMap[f.source] ?? null;
    const def = allFields.find((d) => d.name === current && d.modality === 'contact' && WRITABLE_TYPES.has(d.type));
    // Named only when the target exists but belongs to another modality — that is
    // the case Apollo accepts and discards, and the reason this panel exists.
    const elsewhere = current && !def ? allFields.find((d) => d.name === current) : undefined;
    return {
      source: f.source,
      describe: f.describe,
      defaultTarget: DEFAULT_EXPORT_FIELD_POLICY[f.source] ?? null,
      current,
      brokenModality: elsewhere && elsewhere.modality !== 'contact' ? elsewhere.modality : null,
    };
  });

  let credentials: Awaited<ReturnType<typeof getMaskedCredentials>> = {};
  let loadError: string | null = null;
  if (supabaseOn) {
    try {
      credentials = await getMaskedCredentials();
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  }

  const byCategory = new Map<string, typeof keyedSources>();
  for (const s of keyedSources) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s);
    byCategory.set(s.category, list);
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground">Settings</h1>

      {/* The whole configuration as one file. Above the keys because it is the
          thing an admin comes here to read, where the keys are write-only. */}
      <section className="mt-6">
        <h2 className="text-foreground text-lg font-semibold">Configuration</h2>
        <p className="text-muted mt-1 max-w-3xl text-sm">
          Every parameter the platform runs on, gathered from the nine tables that hold them. Useful for reviewing what
          is actually in force, keeping a copy in version control, or comparing two environments.
        </p>
        <div className="mt-4">
          <ConfigExport />
        </div>
      </section>

      {/* Platform API keys — encrypted at rest, editable here */}
      <section className="mt-12">
        <h2 className="text-foreground text-lg font-semibold">API Keys</h2>
        <p className="text-muted mt-1 max-w-3xl text-sm">
          Every key the platform uses, stored encrypted in the database rather than in environment variables. Values are
          write-only — the server never sends a stored key back to the browser.
        </p>
        <div className="mt-4">
          <SecretsPanel statuses={secrets.statuses} keyId={activeKeyId()} tableMissing={secrets.tableMissing} />
        </div>
      </section>

      {/*
        Directly after the keys, because it depends on one: the choices are read
        from Apollo with the key above, and the panel says so when it cannot.
      */}
      <section className="mt-12">
        <h2 className="text-foreground text-lg font-semibold">Apollo export fields</h2>
        <p className="text-muted mt-1 max-w-3xl text-sm">
          Apollo has no field for a construction project, so everything that makes a lead worth calling is written into
          custom fields. Apollo accepts a field it will not store and answers 200, so a mapping that stops working is
          silent — this is where it gets corrected without a deploy.
        </p>
        <div className="mt-4">
          <ApolloFieldMapPanel
            sources={fieldSources}
            options={uniqueFieldOptions}
            isDefault={fieldMapIsDefault}
            apolloConfigured={allFields.length > 0}
          />
        </div>
      </section>

      {/* Per-source credential storage (Supabase-backed) */}
      <section className="mt-12">
        <h2 className="text-lg font-semibold text-foreground">MCP access tokens</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Let an AI assistant read the pipeline over HTTP at <code>/api/mcp</code> — the same tools the local MCP
          server offers, read-only, scoped to the role you pick. Point Claude Desktop or any MCP client at that URL
          with the token as a bearer header.
        </p>
        <div className="mt-4">
          <TokenManager tokens={tokens} roles={tokenRoles} tableMissing={tokensMissing} />
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold text-foreground">Connected assistants</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Assistants people have connected through the Claude connector flow, rather than with a token. Each one reads as
          the person who approved it — through <em>their</em> role, so it narrows when their role does and stops when
          their account is deactivated. Add the connector by pointing it at <code>/api/mcp</code>; it registers and asks
          for approval on its own, with nothing to paste.
        </p>
        <div className="mt-4">
          <ConnectionManager connections={connections} tableMissing={connectionsMissing} />
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold text-foreground">Source Credentials</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Save a key per source (stored server-side in <code>source_credentials</code>, taking priority over env vars —
          no restart required). Once saved,{' '}
          <a href="/control/sources" className="underline">
            Search
          </a>{' '}
          uses it automatically: the key field there becomes an optional per-search override rather than a requirement.
          Barbour ABI and Glenigan offer a Test Connection button. Requires Supabase.
        </p>

        {!supabaseOn ? (
          <div className="mt-4">
            <SupabaseNotConfigured detail="Source-credential storage needs Supabase. Configure the keys above in .env.local for now, or set up Supabase to save keys from this page." />
          </div>
        ) : loadError ? (
          <div className="mt-4">
            <SupabaseNotConfigured detail={loadError} />
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            {Array.from(byCategory.entries()).map(([category, categorySources]) => (
              <details key={category} className="rounded-lg border border-border-base bg-surface" open>
                <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-foreground">
                  {category} <span className="font-normal text-muted">({categorySources.length} sources)</span>
                </summary>

                <div className="divide-y divide-border-base border-t border-border-base">
                  {categorySources.map((source) => {
                    const credential = credentials[source.sourceKey];
                    const isConfigured = credential?.isConfigured ?? false;
                    const slug = source.slug;
                    const needsUsername = SOURCE_SLUGS[slug ?? '']?.needsUsername ?? false;

                    return (
                      <div
                        key={source.sourceKey}
                        className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
                      >
                        <div className="min-w-0 sm:w-56 sm:shrink-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground">{source.name}</span>
                            {slug ? (
                              <Badge tone="success">Live</Badge>
                            ) : null}
                          </div>
                          <span className="mt-0.5 block text-[11px] text-muted">{source.coverage}</span>
                          <span
                            className={cn('mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium', badgeTone[isConfigured ? 'success' : 'neutral'])}
                          >
                            {isConfigured ? 'Configured' : 'Not configured'}
                          </span>
                          {credential?.lastTestedAt ? (
                            <p className="mt-1 text-[11px] text-muted">
                              Last tested: {new Date(credential.lastTestedAt).toLocaleString()} (
                              {credential.lastTestResult})
                            </p>
                          ) : null}
                        </div>

                        <div className="flex-1">
                          <CredentialForm
                            sourceKey={source.sourceKey}
                            maskedApiKey={credential?.maskedApiKey ?? null}
                            baseUrl={credential?.baseUrl ?? null}
                            username={credential?.username ?? null}
                            hasPassword={credential?.hasPassword ?? false}
                            showUsernamePassword={needsUsername}
                          />
                        </div>

                        <div className="sm:shrink-0">
                          {slug ? (
                            <TestConnectionButton slug={slug} />
                          ) : (
                            <span className="text-xs italic text-muted">Adapter not implemented yet</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
