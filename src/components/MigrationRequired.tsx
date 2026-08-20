import { Callout, CalloutCode } from '@/components/ui';

/**
 * Shown when the priority/enrichment migration hasn't been applied yet. The
 * alternative would be an empty table with no explanation — this says exactly
 * which file to run and what is degraded until it is.
 */
export default function MigrationRequired({ feature }: { feature: string }) {
  return (
    <Callout size="md" title="Migration required">
      <p>
        {feature} needs the priority and enrichment columns, which aren&apos;t in this database yet. Everything else
        keeps working — run the migration and this section fills in.
      </p>
      <p className="mt-3 text-xs">
        Run <CalloutCode>supabase/migrations/20260726110000_priority_and_enrichment_runs.sql</CalloutCode> in the
        Supabase SQL editor (or <CalloutCode>supabase db push</CalloutCode>), then run{' '}
        <strong>Score &amp; route all</strong> on /routing.
      </p>
    </Callout>
  );
}
