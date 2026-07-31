#!/usr/bin/env node
/**
 * Ingests the GEM tracker files in the local folder into canonical_projects.
 *
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *     --import ./scripts/lib/register-alias.mjs \
 *     scripts/ingest-gem-local.mjs [--dry] [file.json ...]
 *
 * The Source Hub's "Load from server folder" button does the same thing, but it
 * needs a signed-in admin session. This does not, so it also works headless and
 * on a fresh install where sign-in is not yet configured.
 *
 * --dry parses and normalizes without writing anything, and reports what WOULD
 * land per tracker. Always worth running first: these files are large and the
 * record count is not obvious from the file sizes.
 *
 * Writes are idempotent — canonical_projects has a unique constraint on
 * (source_key, source_unique_id), so re-running updates rather than duplicates.
 * Reads the folder from GEM_DATA_DIR, defaulting to ./data/gem.
 */

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const requested = args.filter((a) => !a.startsWith('--'));

const { readGemFiles, gemDir } = await import('../src/lib/gem/local.ts');
const { parseGemFile, normalizeGemFile, trackerFromFilename, trackerLabel } = await import(
  '../src/lib/gem/normalize.ts'
);

const { inputs, dir, error } = await readGemFiles(requested);
if (error) {
  console.error(error);
  process.exit(1);
}
if (inputs.length === 0) {
  console.error(`No .json tracker files found in ${gemDir()}.`);
  process.exit(1);
}

console.log(`${dry ? 'DRY RUN — nothing will be written' : 'Ingesting'} from ${dir}`);
console.log(`${inputs.length} file(s)\n`);

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => n.toLocaleString('en-US');

if (dry) {
  // Parsed one file at a time and released, so an 8 MB tracker does not sit in
  // memory alongside the other seventeen.
  let totalParsed = 0;
  let totalNormalized = 0;
  let totalFailed = 0;

  console.log(`${pad('FILE', 26)}${pad('TRACKER', 20)}${pad('PARSED', 10)}${pad('NORMALIZED', 12)}FAILED`);
  for (const input of inputs) {
    const tracker = trackerFromFilename(input.name);
    try {
      const rows = parseGemFile(input.text);
      const { records, failed } = normalizeGemFile(rows, tracker);
      totalParsed += rows.length;
      totalNormalized += records.length;
      totalFailed += failed;
      console.log(
        `${pad(input.name, 26)}${pad(trackerLabel(tracker), 20)}${pad(num(rows.length), 10)}${pad(num(records.length), 12)}${num(failed)}`
      );
    } catch (err) {
      console.log(`${pad(input.name, 26)}${pad(trackerLabel(tracker), 20)}ERROR — ${err.message}`);
    }
  }

  console.log(`\n${num(totalNormalized)} records would be written (${num(totalParsed)} parsed, ${num(totalFailed)} unusable).`);
  console.log('Re-run without --dry to persist.');
  process.exit(0);
}

const { processGemFiles } = await import('../src/lib/gem/ingest.ts');

const startedAt = Date.now();
const res = await processGemFiles(inputs);

console.log(
  `${pad('FILE', 26)}${pad('NORMALIZED', 12)}${pad('INSERTED', 10)}${pad('UPDATED', 9)}${pad('COLLAPSED', 11)}FAILED`
);
for (const f of res.files) {
  const line = `${pad(f.file, 26)}${pad(num(f.normalized), 12)}${pad(num(f.inserted ?? 0), 10)}${pad(num(f.updated ?? 0), 9)}${pad(num(f.collapsed ?? 0), 11)}${num(f.failed)}`;
  console.log(f.error ? `${line}\n  ERROR ${f.error}` : line);
}

const errors = res.files.filter((f) => f.error);
console.log(`\npersisted: ${res.persisted}`);
console.log(res.message);
console.log(
  `normalized ${num(res.totals.normalized)}, inserted ${num(res.totals.inserted)}, updated ${num(res.totals.updated)}, collapsed ${num(res.totals.collapsed)} in ${Math.round((Date.now() - startedAt) / 1000)}s`
);
if (errors.length) console.log(`${errors.length} file(s) errored — see above.`);

// Persisted nothing despite having files is a failure worth a non-zero exit,
// so this is usable in a pipeline.
process.exit(res.totals.normalized > 0 ? 0 : 1);
