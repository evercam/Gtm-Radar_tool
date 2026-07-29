import 'server-only';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { trackerFromFilename, trackerLabel } from '@/lib/gem/normalize';
import type { GemFileInput } from '@/lib/gem/ingest';

/**
 * Server-side access to a local GEM export folder, shared by the page (initial
 * SSR list), the GET list route, and the POST ingest route. Access is
 * sandboxed to GEM_DATA_DIR: only its own top-level `.json` files, resolved by
 * basename so a crafted name cannot escape the folder.
 *
 * Defaults to this project's own `data/gem/` folder. Point GEM_DATA_DIR at any
 * folder of GEM JSON exports to read from elsewhere — the app stays
 * self-contained and never hardcodes a path into another project.
 */
function defaultGemDir(): string {
  return path.join(process.cwd(), 'data', 'gem');
}

export interface GemLocalFile {
  name: string;
  sizeBytes: number;
  tracker: string;
  trackerLabel: string;
}

export interface GemDirListing {
  ok: boolean;
  dir: string;
  files: GemLocalFile[];
  message?: string;
}

export function gemDir(): string {
  return (process.env.GEM_DATA_DIR?.trim() || defaultGemDir()).replace(/\\/g, '/');
}

/** Resolve a requested name to a safe absolute path inside the folder, or null. */
function safePath(dir: string, name: string): string | null {
  const base = path.basename(name);
  if (base !== name || !base.toLowerCase().endsWith('.json')) return null;
  const resolved = path.resolve(dir, base);
  if (path.dirname(resolved) !== path.resolve(dir)) return null;
  return resolved;
}

/** List the `.json` files in the configured GEM folder (never throws). */
export async function listGemDir(): Promise<GemDirListing> {
  const dir = gemDir();
  try {
    const entries = await readdir(dir);
    const jsonFiles = entries.filter((f) => f.toLowerCase().endsWith('.json'));
    const files = await Promise.all(
      jsonFiles.map(async (name) => {
        const info = await stat(path.join(dir, name)).catch(() => null);
        const tracker = trackerFromFilename(name);
        return { name, sizeBytes: info?.size ?? 0, tracker, trackerLabel: trackerLabel(tracker) };
      })
    );
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, dir, files };
  } catch (err) {
    return {
      ok: false,
      dir,
      files: [],
      message: `Could not read GEM folder "${dir}": ${err instanceof Error ? err.message : String(err)}.`,
    };
  }
}

/**
 * Persist uploaded raw files into the GEM folder so they become searchable and
 * re-ingestable. Sanitized to `.json` basenames inside the folder. Best-effort
 * per file; returns which names were saved.
 */
export async function saveGemFiles(
  files: { name: string; text: string }[]
): Promise<{ saved: string[]; dir: string; error?: string }> {
  const dir = gemDir();
  const saved: string[] = [];
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    return {
      saved,
      dir,
      error: `Could not create GEM folder "${dir}": ${err instanceof Error ? err.message : String(err)}.`,
    };
  }
  for (const f of files) {
    const base = path.basename(f.name);
    if (!base.toLowerCase().endsWith('.json')) continue;
    const target = path.resolve(dir, base);
    if (path.dirname(target) !== path.resolve(dir)) continue; // no traversal
    try {
      await writeFile(target, f.text, 'utf8');
      saved.push(base);
    } catch {
      // Skip a file we couldn't write; others still save.
    }
  }
  return { saved, dir };
}

/**
 * Read selected files (or all `.json` files when `requested` is empty) from the
 * folder into GemFileInput[]. Returns `{ error }` only when the folder itself
 * can't be listed; unreadable individual files are skipped.
 */
export async function readGemFiles(
  requested?: string[]
): Promise<{ inputs: GemFileInput[]; dir: string; error?: string }> {
  const dir = gemDir();
  let names: string[];
  try {
    const all = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.json'));
    names = requested && requested.length > 0 ? requested.filter((n) => all.includes(path.basename(n))) : all;
  } catch (err) {
    return {
      inputs: [],
      dir,
      error: `Could not read GEM folder "${dir}": ${err instanceof Error ? err.message : String(err)}.`,
    };
  }

  const inputs: GemFileInput[] = [];
  for (const name of names) {
    const full = safePath(dir, name);
    if (!full) continue;
    try {
      inputs.push({ name: path.basename(name), text: await readFile(full, 'utf8') });
    } catch {
      // Skip unreadable file.
    }
  }
  return { inputs, dir };
}
