'use client';

import { useActionState } from 'react';
import { saveSourceCredential, type SaveCredentialResult } from '@/lib/actions/credentials';

export default function CredentialForm({
  sourceKey,
  maskedApiKey,
  baseUrl,
  username,
  hasPassword,
  showUsernamePassword,
}: {
  sourceKey: string;
  maskedApiKey: string | null;
  baseUrl: string | null;
  username?: string | null;
  hasPassword?: boolean;
  /** Only Barbour ABI's two-step auth needs a separate username + password alongside the API key. */
  showUsernamePassword?: boolean;
}) {
  const [state, formAction, isPending] = useActionState<SaveCredentialResult | null, FormData>(
    saveSourceCredential,
    null
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="sourceKey" value={sourceKey} />
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {showUsernamePassword ? (
          <>
            <input
              type="text"
              name="username"
              defaultValue={username ?? ''}
              placeholder="Username"
              autoComplete="off"
              className="w-full min-w-0 rounded border border-border-base bg-surface px-2 py-1.5 text-sm sm:w-40"
            />
            <input
              type="password"
              name="password"
              placeholder={hasPassword ? '••••••• (leave blank to keep)' : 'Password'}
              autoComplete="off"
              className="w-full min-w-0 rounded border border-border-base bg-surface px-2 py-1.5 text-sm sm:w-40"
            />
          </>
        ) : null}
        <input
          type="password"
          name="apiKey"
          placeholder={
            maskedApiKey
              ? `${maskedApiKey} (leave blank to keep)`
              : showUsernamePassword
                ? 'API key (x-api-key)'
                : 'API key'
          }
          autoComplete="off"
          className="w-full min-w-0 rounded border border-border-base bg-surface px-2 py-1.5 text-sm sm:w-56"
        />
        <input
          type="text"
          name="baseUrl"
          defaultValue={baseUrl ?? ''}
          placeholder="Base URL"
          className="w-full min-w-0 rounded border border-border-base bg-surface px-2 py-1.5 text-sm sm:w-56"
        />
        <button
          type="submit"
          disabled={isPending}
          className="shrink-0 rounded bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-surface-raised disabled:opacity-50-raised"
        >
          {isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {state ? (
        <span
          className={`text-xs ${state.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
