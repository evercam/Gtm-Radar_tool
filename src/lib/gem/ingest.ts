import 'server-only';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { GEM_SOURCE_KEY, normalizeGemFile, parseGemFile, trackerFromFilename, trackerLabel } from '@/lib/gem/normalize';
import type { CanonicalProjectInsert } from '@/lib/adapters/types';
import { sourceProvenance } from '@/lib/provenance';

const UPSERT_CHUNK = 500;

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
  error?: string;
}

export interface GemIngestResult {
  ok: boolean;
  persisted: boolean;
  message: string;
  totals: { normalized: number; inserted: number; updated: number };
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

  const results: GemFileResult[] = [];
  const sample: CanonicalProjectInsert[] = [];
  let totalNormalized = 0;
  let totalInserted = 0;
  let totalUpdated = 0;

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
      totalNormalized += records.length;
      if (sample.length < 5) sample.push(...records.slice(0, 5 - sample.length));

      if (supabase && records.length > 0) {
        const { inserted, updated } = await upsertRecords(supabase, records);
        result.inserted = inserted;
        result.updated = updated;
        totalInserted += inserted;
        totalUpdated += updated;
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }

    results.push(result);
  }

  if (supabase && totalNormalized > 0) {
    await supabase
      .from('source_registry')
      .update({ last_successful_fetch: new Date().toISOString(), health_status: 'healthy', consecutive_failures: 0 })
      .eq('source_key', GEM_SOURCE_KEY);
  }

  return {
    ok: true,
    persisted: dbReady,
    message: dbReady
      ? `Ingested ${totalInserted} new + ${totalUpdated} updated GEM records into canonical_projects.`
      : `Parsed and normalized ${totalNormalized} GEM records. Configure Supabase to persist them to the database.`,
    totals: { normalized: totalNormalized, inserted: totalInserted, updated: totalUpdated },
    files: results,
    sample,
  };
}

/**
 * Chunked upsert with inserted-vs-updated accounting, keyed on the
 * canonical_projects (source_key, source_unique_id) unique constraint.
 */
async function upsertRecords(
  supabase: ReturnType<typeof getServiceSupabase>,
  records: CanonicalProjectInsert[]
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;

  for (let i = 0; i < records.length; i += UPSERT_CHUNK) {
    const chunk = records.slice(i, i + UPSERT_CHUNK);
    const ids = chunk.map((r) => r.source_unique_id);

    const { data: existing } = await supabase
      .from('canonical_projects')
      .select('source_unique_id')
      .eq('source_key', GEM_SOURCE_KEY)
      .in('source_unique_id', ids);

    const existingIds = new Set((existing ?? []).map((r: { source_unique_id: string }) => r.source_unique_id));
    const chunkInserted = chunk.filter((r) => !existingIds.has(r.source_unique_id)).length;
    inserted += chunkInserted;
    updated += chunk.length - chunkInserted;

    const { error } = await supabase
      .from('canonical_projects')
      .upsert(chunk, { onConflict: 'source_key,source_unique_id' });
    if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  return { inserted, updated };
}
