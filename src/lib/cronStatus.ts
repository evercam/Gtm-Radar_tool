import 'server-only';
import { getServiceSupabase } from '@/lib/supabase/server';

/**
 * Configuration reads go through the service role, not the caller's session.
 *
 * These tables are not scoped to a person — their policies say "any signed-in
 * user may read", and the pages that render them are permission-gated already.
 * Routing them through the request client made them depend on a PostgREST
 * token this app can no longer mint, so they silently returned nothing: a
 * roster entry would save correctly and then not appear.
 *
 * `canonical_projects` is deliberately NOT in this group. That data IS scoped
 * per user, and it waits for the direct-Postgres path in lib/db/pool.ts rather
 * than being widened to the service role.
 */
const configReader = () => getServiceSupabase();

/**
 * When the scheduler was last heard from.
 *
 * A scheduler that silently stops looks exactly like a quiet period, so the
 * Control Center reports staleness rather than only reporting failures. Any
 * run inside 48 hours counts as recent — the daily jobs fire once a day, so a
 * tighter window would flag a normal gap as an outage.
 */
export interface CronStatus {
  configured: boolean;
  lastRanAt: string | null;
  lastOk: boolean;
  recent: boolean;
}

const RECENT_WINDOW_HOURS = 48;

export async function getLastCronRun(): Promise<CronStatus> {
  const configured = Boolean(process.env.CRON_SECRET?.trim());

  try {
    const { data, error } = await (
      configReader()
    )
      .from('cron_runs')
      .select('ran_at, ok')
      .order('ran_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return { configured, lastRanAt: null, lastOk: false, recent: false };

    const row = data as { ran_at: string; ok: boolean };
    const hours = (Date.now() - new Date(row.ran_at).getTime()) / 3_600_000;
    return { configured, lastRanAt: row.ran_at, lastOk: row.ok, recent: hours < RECENT_WINDOW_HOURS };
  } catch {
    return { configured, lastRanAt: null, lastOk: false, recent: false };
  }
}
