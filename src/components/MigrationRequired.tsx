/**
 * Shown when the priority/enrichment migration hasn't been applied yet. The
 * alternative would be an empty table with no explanation — this says exactly
 * which file to run and what is degraded until it is.
 */
export default function MigrationRequired({ feature }: { feature: string }) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 dark:border-amber-900/60 dark:bg-amber-950/30">
      <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">Migration required</h3>
      <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
        {feature} needs the priority and enrichment columns, which aren&apos;t in this database yet. Everything else
        keeps working — run the migration and this section fills in.
      </p>
      <p className="mt-3 text-xs text-amber-800 dark:text-amber-300">
        Run{' '}
        <code className="rounded bg-amber-100 px-1.5 py-0.5 font-mono dark:bg-amber-900/50">
          supabase/migrations/20260726110000_priority_and_enrichment_runs.sql
        </code>{' '}
        in the Supabase SQL editor (or{' '}
        <code className="rounded bg-amber-100 px-1.5 py-0.5 font-mono dark:bg-amber-900/50">supabase db push</code>),
        then run <strong>Score &amp; route all</strong> on /routing.
      </p>
    </div>
  );
}
