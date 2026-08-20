import { cn } from '@/lib/cn';
import { calloutTone } from '@/lib/status-colors';

export default function SupabaseNotConfigured({ detail }: { detail?: string }) {
  return (
    <div className={cn('mx-auto max-w-2xl rounded-lg border p-6', calloutTone.warning)}>
      <h2 className="text-lg font-semibold">Supabase is not configured</h2>
      <p className="mt-2 text-sm leading-6">
        This page reads live data from Supabase, which has not been connected yet.
      </p>
      <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm">
        <li>Create a Supabase project at supabase.com.</li>
        <li>
          Run <code className="rounded bg-black/10 px-1 py-0.5">supabase_setup.sql</code> in its SQL editor.
        </li>
        <li>
          Copy <code className="rounded bg-black/10 px-1 py-0.5">.env.local.example</code> to{' '}
          <code className="rounded bg-black/10 px-1 py-0.5">.env.local</code> and fill in the Supabase keys.
        </li>
        <li>
          Restart <code className="rounded bg-black/10 px-1 py-0.5">npm run dev</code>.
        </li>
      </ol>
      {detail ? <p className="mt-3 text-xs opacity-70">{detail}</p> : null}
    </div>
  );
}
