/**
 * Three registries describe a source, and they have to agree.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-source-registry.mjs
 *
 *   SOURCE_CATALOG    what /sources shows, and the source_key its counts join on
 *   LIVE_ADAPTERS     what can actually be fetched, keyed by slug
 *   SOURCE_SLUGS      what the scheduler and the ingest route can address
 *
 * Every disagreement between them is silent, and each one has already happened:
 *
 *   - news-search was built, registered and tested, and missing from
 *     SOURCE_SLUGS, so the scheduler could not see it. It would have run never.
 *   - The OCDS and Socrata adapters were exported by array position, so
 *     inserting a publisher in the middle repointed the ones after it —
 *     Contracts Finder briefly became Public Contracts Scotland under Contracts
 *     Finder's own source_key.
 *   - project_intelligence had 179 records and no catalog entry, so /sources
 *     could not show them and their count appeared in no total.
 *
 * None of those broke a build or failed a test. They are all shape mismatches
 * between lists that nothing compared, which is exactly what this file is for.
 *
 * Pure — no network, no database.
 */

import { SOURCE_CATALOG } from '@/lib/sourceCatalog';
import { LIVE_ADAPTERS, LIVE_SOURCE_SLUGS } from '@/lib/adapters';
import { SOURCE_SLUGS } from '@/lib/sourceSlugs';

let passed = 0,
  failed = 0;
const check = (n, c, d) => {
  if (c) {
    passed++;
    console.log(`  PASS ${n}`);
  } else {
    failed++;
    console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`);
  }
};

console.log('The catalog is internally sound');
{
  const keys = SOURCE_CATALOG.map((c) => c.sourceKey);
  const dupeKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
  check('no duplicate source_key', dupeKeys.length === 0, dupeKeys.join(', '));

  const slugs = SOURCE_CATALOG.map((c) => c.slug).filter(Boolean);
  const dupeSlugs = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  check('no duplicate slug', dupeSlugs.length === 0, dupeSlugs.join(', '));

  check('every entry has a name', SOURCE_CATALOG.every((c) => c.name?.trim()));
  check('every entry has a source_key', SOURCE_CATALOG.every((c) => c.sourceKey?.trim()));
  check('every entry has a category', SOURCE_CATALOG.every((c) => c.category?.trim()));
  check(
    'auth is one of the three kinds',
    SOURCE_CATALOG.every((c) => ['keyless', 'keyed', 'upload'].includes(c.auth)),
    SOURCE_CATALOG.filter((c) => !['keyless', 'keyed', 'upload'].includes(c.auth)).map((c) => c.name).join(', ')
  );
}

console.log('\nEvery adapter is addressable and correctly attributed');
{
  for (const slug of LIVE_SOURCE_SLUGS) {
    const entry = SOURCE_CATALOG.find((c) => c.slug === slug);
    check(`${slug}: in the catalog`, Boolean(entry));
    if (!entry) continue;

    /*
      The check that catches a positional-index mistake. An adapter exported for
      the wrong publisher still satisfies the interface and still fetches — it
      just writes another source's data under this source_key, and nothing
      anywhere would say so.
    */
    check(`${slug}: adapter's sourceKey matches the catalog`, LIVE_ADAPTERS[slug].sourceKey === entry.sourceKey, `adapter=${LIVE_ADAPTERS[slug].sourceKey} catalog=${entry.sourceKey}`);
    check(`${slug}: the scheduler can address it`, slug in SOURCE_SLUGS);
    if (slug in SOURCE_SLUGS) {
      check(`${slug}: slug map agrees on the source_key`, SOURCE_SLUGS[slug].sourceKey === entry.sourceKey, `map=${SOURCE_SLUGS[slug].sourceKey} catalog=${entry.sourceKey}`);
    }
  }
}

console.log('\nNothing is addressable that cannot be fetched');
{
  // A slug the scheduler knows with no adapter behind it is a scheduled run that
  // 404s on its own ingest route, once a day, quietly.
  const orphans = Object.keys(SOURCE_SLUGS).filter((s) => !LIVE_SOURCE_SLUGS.includes(s));
  check('every scheduled slug has an adapter', orphans.length === 0, orphans.join(', '));

  // A catalog entry WITH a slug promises it can be run.
  const promised = SOURCE_CATALOG.filter((c) => c.slug && !LIVE_ADAPTERS[c.slug]);
  check('no catalog slug lacks an adapter', promised.length === 0, promised.map((c) => c.slug).join(', '));
}

console.log('\nMetadata-only sources are deliberate, not accidental');
{
  /*
    An entry with no slug cannot be fetched, which is legitimate — an upload or a
    historical import. What must not happen is a KEYLESS or KEYED source with no
    slug, because that reads as "we can pull this" while nothing can.
  */
  const noSlug = SOURCE_CATALOG.filter((c) => !c.slug);
  check(`${noSlug.length} source(s) are metadata-only`, noSlug.length > 0, 'expected at least the imports');
  check(
    'every metadata-only source is an upload',
    noSlug.every((c) => c.auth === 'upload'),
    noSlug.filter((c) => c.auth !== 'upload').map((c) => `${c.name} (${c.auth})`).join(', ')
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
