/**
 * Reading the event log.
 *
 * Kept apart from the writer so the page that displays events does not import
 * the service-key client. The writer needs the service key because a browser
 * session must not be able to forge an event; the reader deliberately does not.
 */

import { getReadSupabase } from '@/lib/supabase/server';

export interface EventRow {
  id: number;
  kind: string;
  name: string;
  ok: boolean | null;
  duration_ms: number | null;
  detail: Record<string, unknown> | null;
  actor: string | null;
  at: string;
}

export interface EventQuery {
  kind?: string;
  /** 'failed' narrows to ok = false; 'slow' to anything with a duration. */
  outcome?: 'failed' | 'ok' | 'all';
  name?: string;
  limit?: number;
}

/*
  One literal select string.

  Concatenating it collapses every row to GenericStringError in supabase-js's
  types, so the rows type-check as errors and every field access has to be cast.
  This has bitten this codebase before; it stays on one line.
*/
const EVENT_COLUMNS = 'id, kind, name, ok, duration_ms, detail, actor, at';

/** The most recent events, newest first. */
export async function getEvents(query: EventQuery = {}): Promise<{ rows: EventRow[]; unavailable: boolean }> {
  const supabase = await getReadSupabase();
  let q = supabase.from('app_events').select(EVENT_COLUMNS).order('at', { ascending: false });

  if (query.kind) q = q.eq('kind', query.kind);
  if (query.name) q = q.eq('name', query.name);
  if (query.outcome === 'failed') q = q.eq('ok', false);
  if (query.outcome === 'ok') q = q.eq('ok', true);

  const { data, error } = await q.limit(Math.min(500, Math.max(1, query.limit ?? 200)));

  /*
    `unavailable` rather than an empty list, for the reason this whole feature
    exists: an empty log and an unreadable log are different facts, and returning
    [] for both is how a failure becomes a zero on a page.
  */
  if (error) return { rows: [], unavailable: true };
  return { rows: (data ?? []) as EventRow[], unavailable: false };
}

export interface KindSummary {
  kind: string;
  total: number;
  failed: number;
}

/**
 * Counts per kind over a window, so the page can lead with what is wrong rather
 * than with whatever happened most recently.
 *
 * Counted from one page of rows rather than a GROUP BY: the window is capped, so
 * this is a bounded read, and adding an RPC for a summary of at most 2,000 rows
 * would be more machinery than the number is worth. If the log ever grows to the
 * point where this matters, it becomes an RPC like the KPI rollups need to.
 */
export async function getEventSummary(hours = 24): Promise<{ kinds: KindSummary[]; since: string; unavailable: boolean }> {
  const supabase = await getReadSupabase();
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from('app_events')
    .select('kind, ok')
    .gte('at', since)
    .order('at', { ascending: false })
    .limit(2000);

  if (error) return { kinds: [], since, unavailable: true };

  const byKind = new Map<string, KindSummary>();
  for (const r of (data ?? []) as { kind: string; ok: boolean | null }[]) {
    const entry = byKind.get(r.kind) ?? { kind: r.kind, total: 0, failed: 0 };
    entry.total += 1;
    if (r.ok === false) entry.failed += 1;
    byKind.set(r.kind, entry);
  }

  // Failures first, then volume — the reason to open this page is that something
  // broke, not that something was busy.
  return {
    kinds: [...byKind.values()].sort((a, b) => b.failed - a.failed || b.total - a.total),
    since,
    unavailable: false,
  };
}
