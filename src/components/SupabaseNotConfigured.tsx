import { Callout, CalloutCode } from '@/components/ui';

export default function SupabaseNotConfigured({ detail }: { detail?: string }) {
  return (
    <Callout size="md" title="Supabase is not configured" className="mx-auto max-w-2xl">
      <p className="mt-2 text-sm leading-6">
        This page reads live data from Supabase, which has not been connected yet.
      </p>
      <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm">
        <li>Create a Supabase project at supabase.com.</li>
        <li>
          Run <CalloutCode>supabase_setup.sql</CalloutCode> in its SQL editor.
        </li>
        <li>
          Copy <CalloutCode>.env.local.example</CalloutCode> to{' '}
          <CalloutCode>.env.local</CalloutCode> and fill in the Supabase keys.
        </li>
        <li>
          Restart <CalloutCode>npm run dev</CalloutCode>.
        </li>
      </ol>
      {detail ? <p className="mt-3 text-xs opacity-70">{detail}</p> : null}
    </Callout>
  );
}
