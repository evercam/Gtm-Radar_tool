import Link from 'next/link';
import { requirePermission } from '@/lib/auth/session';
import { isSupabaseServerConfigured, getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getEnrichmentPolicy } from '@/lib/policies';
import SupabaseNotConfigured from '@/components/SupabaseNotConfigured';
import CostCalculator, { type CostContext } from '@/components/control/CostCalculator';

export const dynamic = 'force-dynamic';

/**
 * Observed cost inputs, taken from what this install has actually done rather
 * than from an assumption. A calculator fed only by guesses tells you what you
 * hoped would happen.
 */
async function observed(): Promise<{ queued: number; contactRate: number | null; runs: number }> {
  if (!isSupabaseServiceConfigured()) return { queued: 0, contactRate: null, runs: 0 };
  const service = getServiceSupabase();

  const [{ count: queued }, { data: runs }] = await Promise.all([
    service
      .from('canonical_projects')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'PENDING_ENRICHMENT'),
    service.from('enrichment_runs').select('requested, succeeded, contacts_found').eq('status', 'completed').limit(100),
  ]);

  const rows = (runs ?? []) as { requested: number; contacts_found: number }[];
  const attempted = rows.reduce((n, r) => n + (r.requested ?? 0), 0);
  const found = rows.reduce((n, r) => n + (r.contacts_found ?? 0), 0);

  return {
    queued: queued ?? 0,
    contactRate: attempted > 0 ? found / attempted : null,
    runs: rows.length,
  };
}

export default async function CostsPage() {
  await requirePermission('enrichment.run', '/admin/costs');

  if (!isSupabaseServerConfigured()) return <SupabaseNotConfigured />;

  const [{ config: policy }, stats] = await Promise.all([getEnrichmentPolicy(), observed()]);

  const ctx: CostContext = {
    queued: stats.queued,
    dailyCap: policy.dailyCap,
    monthlyCap: policy.monthlyCap,
    batchSize: policy.batchSize,
    claudeEnabled: policy.engines.claude,
    callPrepEnabled: policy.generateCallPrep,
    apolloEnabled: policy.engines.apollo,
    contactsPerAccount: policy.contactsPerAccount,
    revealPhones: policy.revealPhoneNumbers,
    maxPhoneReveals: policy.maxPhoneRevealsPerRun,
    observedContactRate: stats.contactRate,
    observedRuns: stats.runs,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold">Enrichment cost</h1>
        <p className="text-muted mt-1 max-w-3xl text-sm">
          What a run costs before you start it. Enrichment is the only part of this platform that spends money per
          record, and it spends across three providers in three different units — Anthropic bills tokens, Apollo bills
          credits, GLEIF bills nothing. The switches below start from your live{' '}
          <Link href="/control/enrichment#policy" className="underline">
            enrichment policy
          </Link>
          , so you can model a change here and then make it there.
        </p>
      </div>

      <CostCalculator ctx={ctx} />
    </div>
  );
}
