import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { canTransition, isLeadStatus, STATUS_TIMESTAMP_COLUMN, type LeadStatus } from '@/lib/lifecycle';

/**
 * Writes lifecycle transitions.
 *
 * Every status change goes through here rather than being set inline, so three
 * things always happen together: the status is validated against the allowed
 * graph, the matching timestamp column is stamped, and an entry is appended to
 * `enrichment_history`. A transition written directly would silently skip all
 * three and leave the record's history lying about what happened to it.
 */

export interface TransitionOptions {
  /** Free-text note stored on the history entry. */
  reason?: string;
  /** Extra fields written in the same statement (e.g. enrichment results). */
  patch?: Record<string, unknown>;
  /** Who or what caused it — a user id, or an engine name like 'batch'. */
  actor?: string;
}

export interface TransitionResult {
  ok: boolean;
  from?: LeadStatus;
  to?: LeadStatus;
  message: string;
}

interface HistoryEntry {
  at: string;
  action: string;
  from: LeadStatus | null;
  to: LeadStatus;
  actor: string | null;
  reason?: string;
}

/**
 * Moves one record to `to`, refusing transitions the lifecycle graph forbids.
 *
 * The read-then-write is deliberately not a transaction: PostgREST has no
 * multi-statement transaction, and the guard exists to catch programming
 * mistakes rather than to serialise concurrent workers. The enrichment batch
 * already avoids that race by claiming records through the queue query.
 */
export async function transitionLead(
  id: string,
  to: LeadStatus,
  options: TransitionOptions = {}
): Promise<TransitionResult> {
  if (!isLeadStatus(to)) return { ok: false, message: `"${to}" is not a lifecycle status.` };
  if (!isSupabaseServiceConfigured()) {
    return { ok: false, message: 'Supabase service role is not configured.' };
  }

  const service = getServiceSupabase();

  const { data, error: readError } = await service
    .from('canonical_projects')
    .select('status, enrichment_history')
    .eq('id', id)
    .maybeSingle();

  if (readError) {
    const hint = /does not exist|schema cache/i.test(readError.message)
      ? ' Run the lead_lifecycle migration first.'
      : '';
    return { ok: false, message: `${readError.message}.${hint}` };
  }
  if (!data) return { ok: false, message: 'Record not found.' };

  const row = data as { status: string | null; enrichment_history: unknown };
  const from = isLeadStatus(row.status) ? row.status : 'RAW';

  if (!canTransition(from, to)) {
    return { ok: false, from, to, message: `Cannot move a record from ${from} to ${to}.` };
  }

  const now = new Date().toISOString();
  const entry: HistoryEntry = {
    at: now,
    action: 'status_change',
    from,
    to,
    actor: options.actor ?? null,
    ...(options.reason ? { reason: options.reason } : {}),
  };

  const history = Array.isArray(row.enrichment_history) ? (row.enrichment_history as unknown[]) : [];
  const patch: Record<string, unknown> = {
    ...options.patch,
    status: to,
    enrichment_history: [...history, entry],
  };

  // Stamp the timestamp column belonging to the destination status.
  const stamp = STATUS_TIMESTAMP_COLUMN[to];
  if (stamp) patch[stamp] = now;
  if (to === 'LOST' && options.reason) patch.lost_reason = options.reason;

  const { error } = await service.from('canonical_projects').update(patch).eq('id', id);
  if (error) return { ok: false, from, to, message: error.message };

  return { ok: true, from, to, message: `${from} → ${to}` };
}

/**
 * Moves many records at once — used by the prioritisation job, which queues
 * hundreds in one pass.
 *
 * The per-record history entry is skipped here on purpose: appending to each
 * row's JSONB would mean one statement per record. The bulk action is recorded
 * once on the run instead (`enrichment_runs`), and the timestamp column still
 * marks every row individually.
 */
export async function transitionMany(
  ids: string[],
  to: LeadStatus,
  options: { from?: LeadStatus; patch?: Record<string, unknown> } = {}
): Promise<{ ok: boolean; updated: number; message: string }> {
  if (!isLeadStatus(to)) return { ok: false, updated: 0, message: `"${to}" is not a lifecycle status.` };
  if (ids.length === 0) return { ok: true, updated: 0, message: 'Nothing to update.' };
  if (!isSupabaseServiceConfigured()) {
    return { ok: false, updated: 0, message: 'Supabase service role is not configured.' };
  }

  const service = getServiceSupabase();
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { ...options.patch, status: to };
  const stamp = STATUS_TIMESTAMP_COLUMN[to];
  if (stamp) patch[stamp] = now;

  let updated = 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const slice = ids.slice(i, i + 1000);
    let query = service.from('canonical_projects').update(patch).in('id', slice);
    // Guarding on the expected source status makes a concurrent claim a no-op
    // rather than a double-spend.
    if (options.from) query = query.eq('status', options.from);

    const { error } = await query;
    if (error) return { ok: false, updated, message: error.message };
    updated += slice.length;
  }

  return { ok: true, updated, message: `Moved ${updated} record${updated === 1 ? '' : 's'} to ${to}.` };
}

/** Appends a non-transition event (an enrichment attempt, a validation) to the trail. */
export async function appendHistory(
  id: string,
  action: string,
  detail: Record<string, unknown> = {}
): Promise<boolean> {
  if (!isSupabaseServiceConfigured()) return false;
  try {
    const service = getServiceSupabase();
    const { data } = await service.from('canonical_projects').select('enrichment_history').eq('id', id).maybeSingle();

    const history = Array.isArray((data as { enrichment_history?: unknown } | null)?.enrichment_history)
      ? (data as { enrichment_history: unknown[] }).enrichment_history
      : [];

    const { error } = await service
      .from('canonical_projects')
      .update({ enrichment_history: [...history, { at: new Date().toISOString(), action, ...detail }] })
      .eq('id', id);
    return !error;
  } catch {
    return false;
  }
}
