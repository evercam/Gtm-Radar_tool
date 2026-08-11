/**
 * Writing to the event log.
 *
 * The problem this solves is not "not enough logging". There is plenty of
 * console.warn. The problem is that console.warn goes to a serverless log stream
 * that nobody tails and that rolls off, so a failure is invisible while it is
 * happening and gone by the time anyone asks. Meanwhile the caller writes
 * `?? 0` and the page shows a zero, which reads as an answer.
 *
 * The one rule that matters here: logging must never affect the thing being
 * logged. Every write is best-effort and swallows its own errors. A logging
 * failure that broke a page would be a strictly worse bug than the one the log
 * was added to catch.
 *
 * The redaction and threshold rules live in ./redact, which has no I/O.
 */

import { getServiceSupabase } from '@/lib/supabase/server';
import { sanitiseDetail, shouldRecord, SLOW_MS, type AppEvent, type EventKind } from '@/lib/observability/redact';

export { SLOW_MS, type AppEvent, type EventKind };

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Record an event. Never throws, never rejects.
 *
 * Not awaited internally by callers on a hot path — see `logEventAsync`. This
 * variant returns a promise so a route that is about to respond can await it and
 * be sure the row landed before the serverless instance is frozen, which is the
 * one case where fire-and-forget silently loses the event.
 */
export async function logEvent(event: AppEvent): Promise<void> {
  try {
    if (!shouldRecord(event)) return;
    const detail = sanitiseDetail(event.detail ?? {}) as Record<string, unknown>;
    await getServiceSupabase()
      .from('app_events')
      .insert({
        kind: String(event.kind).slice(0, 40),
        name: String(event.name).slice(0, 120),
        ok: event.ok ?? null,
        duration_ms: event.durationMs == null ? null : Math.round(event.durationMs),
        detail,
        actor: event.actor ? redactActor(event.actor) : null,
      });
  } catch {
    /*
      Deliberately silent. A logging failure must not become the caller's
      problem, and re-logging it here would recurse. If the table is
      unreachable, the console line below is the only place left to say so — and
      even that is guarded, because console can be replaced in some runtimes.
    */
    try {
      console.error('[events] could not record', event.kind, event.name);
    } catch {
      /* nothing left to try */
    }
  }
}

/**
 * Fire-and-forget, for a path that must not wait on a write.
 *
 * Safe to leave unawaited: the promise from `logEvent` never rejects, so this
 * cannot produce an unhandled rejection. The `void` is explicit so a reader can
 * see the omission is deliberate rather than a missing await.
 */
export function logEventAsync(event: AppEvent): void {
  void logEvent(event);
}

/**
 * The actor is an email, and the log should say who without storing the address
 * in a table with looser rules than the user table. The local part is enough to
 * identify a colleague in a nine-person roster.
 *
 * Kept as `name@domain`-with-local-part rather than a hash: an opaque hash makes
 * the log unreadable, which is the failure mode this whole file exists to fix.
 */
function redactActor(actor: string): string {
  const at = actor.indexOf('@');
  return at > 0 ? actor.slice(0, at) : actor.slice(0, 80);
}

/**
 * Run something, measure it, and log a failure or a slow success.
 *
 * The value or the error passes through untouched — this is a measurement, not
 * a try/catch that swallows. An operation that fails still fails; it is just
 * recorded on the way out.
 */
export async function timed<T>(
  kind: EventKind | string,
  name: string,
  fn: () => Promise<T>,
  opts: { detail?: Record<string, unknown>; actor?: string | null; slowMs?: number } = {}
): Promise<T> {
  const startedAt = Date.now();
  try {
    const value = await fn();
    const durationMs = Date.now() - startedAt;
    if (durationMs >= (opts.slowMs ?? SLOW_MS)) {
      logEventAsync({ kind, name, ok: true, durationMs, detail: opts.detail, actor: opts.actor });
    }
    return value;
  } catch (err) {
    logEventAsync({
      kind,
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      detail: { ...opts.detail, error: err instanceof Error ? err.message : String(err) },
      actor: opts.actor,
    });
    throw err;
  }
}
