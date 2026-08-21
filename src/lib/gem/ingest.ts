import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { GEM_SOURCE_KEY, normalizeGemFile, parseGemFile, trackerFromFilename, trackerLabel } from '@/lib/gem/normalize';
import type { CanonicalProjectInsert } from '@/lib/adapters/types';
import { sourceProvenance } from '@/lib/provenance';
import { upsertSourceRecords } from '@/lib/sources/upsertRecords';
import { recordRunOutcome } from '@/lib/sources/config';
import { startRun, finishRun } from '@/lib/sources/runs';


/**
 * GEM's slug, which is what `source_config` and `ingestion_runs` are keyed on.
 *
 * Not interchangeable with `GEM_SOURCE_KEY` (`gem_energy_tracker`) — that is
 * the `canonical_projects.source_key`. Confusing the two is what made the
 * health write below a silent no-op for as long as it existed.
 */
const GEM_SLUG = 'gem';

export interface GemFileInput {
  name: string;
  text: string;
  /** Optional explicit tracker; otherwise inferred from `name`. */
  tracker?: string;
}

export interface GemFileResult {
  file: string;
  tracker: string;
  trackerLabel: string;
  parsed: number;
  normalized: number;
  failed: number;
  inserted?: number;
  updated?: number;
  /**
   * Rows dropped because they resolved to a `source_unique_id` already claimed
   * by an earlier row in the same file — GEM publishes at unit/phase grain and
   * the id resolves to the site. Reported rather than swallowed: it is the gap
   * between "20,524 parsed" and what a user finds in the table.
   */
  collapsed?: number;
  error?: string;
}

export interface GemIngestResult {
  ok: boolean;
  persisted: boolean;
  message: string;
  totals: { normalized: number; inserted: number; updated: number; collapsed: number };
  files: GemFileResult[];
  sample: CanonicalProjectInsert[];
}

/**
 * Parse → normalize → (optionally) upsert a batch of GEM files. Shared by the
 * drag-and-drop upload route and the local-folder route. Never throws on a bad
 * file — the failure is recorded per-file so one bad upload can't abort a batch.
 */
export async function processGemFiles(files: GemFileInput[]): Promise<GemIngestResult> {
  const dbReady = isSupabaseServiceConfigured();
  const supabase = dbReady ? getServiceSupabase() : null;
  const startedAtMs = Date.now();

  // Opened before any work so a run that throws unexpectedly still leaves a
  // trace. Both helpers no-op without a service role and never throw.
  const runId = dbReady
    ? await startRun({ slug: GEM_SLUG, sourceKey: GEM_SOURCE_KEY, trigger: 'manual', params: { files: files.length } })
    : null;

  const results: GemFileResult[] = [];
  const sample: CanonicalProjectInsert[] = [];
  let totalParsed = 0;
  let totalNormalized = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalFailed = 0;
  let totalCollapsed = 0;

  for (const file of files) {
    const tracker = file.tracker ?? trackerFromFilename(file.name);
    const result: GemFileResult = {
      file: file.name,
      tracker,
      trackerLabel: trackerLabel(tracker),
      parsed: 0,
      normalized: 0,
      failed: 0,
    };

    try {
      const rows = parseGemFile(file.text);
      result.parsed = rows.length;
      const { records, failed } = normalizeGemFile(rows, tracker);
      for (const r of records) r.field_provenance = sourceProvenance(r as unknown as Record<string, unknown>);
      result.normalized = records.length;
      result.failed = failed;
      totalParsed += rows.length;
      totalNormalized += records.length;
      totalFailed += failed;
      if (sample.length < 5) sample.push(...records.slice(0, 5 - sample.length));

      if (supabase && records.length > 0) {
        const { inserted, updated, collapsed, unchanged } = await upsertSourceRecords(supabase, GEM_SOURCE_KEY, records);
        if (unchanged > 0) console.log(`[gem] ${unchanged} record(s) already current, not rewritten`);
        result.inserted = inserted;
        result.updated = updated;
        result.collapsed = collapsed;
        totalInserted += inserted;
        totalUpdated += updated;
        totalCollapsed += collapsed;
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }

    results.push(result);
  }

  // Health used to be written to `source_registry`, keyed on `source_key` —
  // wrong table (retired with the single-table model) AND wrong key, so the
  // update matched nothing and GEM showed as permanently unconfigured on the
  // Source Hub no matter how often it ran. It now goes through the same
  // recorder every adapter uses, keyed on the slug `source_config` holds.
  //
  // Failures are recorded too, not just successes. The rolling health status is
  // hysteretic — it needs 3 consecutive failures to read `failing` — which can
  // only ever trigger if failures are reported. The old code reported none, so
  // GEM could not have gone red if every upload had been garbage.
  // Distinct from the `ok` this function returns, which means "did not throw"
  // and stays true so one bad file never fails a whole batch for the caller.
  // This one is the run's health: a run that normalized nothing achieved
  // nothing, whatever the per-file detail says.
  // Normalizing is not persisting. Keying health on the normalized count alone
  // called a run "healthy" while 11 of 18 files had failed at the upsert — the
  // records existed in memory and reached nothing. Any file-level error makes
  // the run unhealthy, so a partial batch reads as degraded with the failing
  // filename in `last_error` rather than as a clean success.
  const fileErrors = results.filter((r) => r.error).map((r) => `${r.file}: ${r.error}`);
  const runOk = totalNormalized > 0 && fileErrors.length === 0;
  const error = runOk
    ? undefined
    : fileErrors.length
      ? fileErrors.join('; ')
      : 'No records normalized from any file.';

  if (dbReady) {
    await recordRunOutcome(GEM_SLUG, { ok: runOk, durationMs: Date.now() - startedAtMs, error });
    await finishRun(runId, {
      ok: runOk,
      fetched: totalParsed,
      normalized: totalNormalized,
      inserted: totalInserted,
      updated: totalUpdated,
      failed: totalFailed,
      error,
      errorKind: runOk ? undefined : 'shape',
      startedAtMs,
    });
  }

  return {
    ok: true,
    persisted: dbReady,
    message: dbReady
      ? `Ingested ${totalInserted} new + ${totalUpdated} updated GEM records into canonical_projects.` +
        (totalCollapsed > 0 ? ` ${totalCollapsed} unit-level rows collapsed onto their site.` : '')
      : `Parsed and normalized ${totalNormalized} GEM records. Configure Supabase to persist them to the database.`,
    totals: { normalized: totalNormalized, inserted: totalInserted, updated: totalUpdated, collapsed: totalCollapsed },
    files: results,
    sample,
  };
}
