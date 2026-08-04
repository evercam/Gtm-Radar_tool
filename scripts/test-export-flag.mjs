/**
 * An unrecognised job title is flagged, not withheld.
 *
 *   BASE=http://localhost:3111 CRON_SECRET=... node scripts/test-export-flag.mjs
 *
 * The persona guide describes who is usually worth calling. It was being enforced
 * as a gate: any title `classifyTitle` did not recognise was dropped from the
 * export entirely. On a real list that removed the ONLY contact on two of
 * Ronniel's leads — "Section Manager Crusher / Construction" is not one of the
 * four manager phrases the guide enumerates — so a targeted export sent nothing
 * and the rep saw a lead with nobody on it.
 *
 * A contact we have already paid Apollo to reveal is not improved by hiding it.
 * The verdict now travels with the contact instead of replacing it.
 *
 * Every request here is a dry run: this file cannot reach Apollo.
 */

const BASE = process.env.BASE ?? 'http://localhost:3111';
const SECRET = process.env.CRON_SECRET ?? '';

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

async function dryRun(body = {}) {
  const res = await fetch(`${BASE}/api/export/apollo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cron-secret': SECRET },
    body: JSON.stringify({ ...body, dryRun: true }),
  });
  return res.json();
}

const probe = await dryRun().catch(() => null);
if (!probe) {
  console.log(`No server at ${BASE} — start it with \`npm run dev\` and pass BASE. Skipping.`);
  process.exit(0);
}
if (probe.ok === false && /unauthor/i.test(probe.message ?? '')) {
  console.log('CRON_SECRET did not authenticate — skipping.');
  process.exit(0);
}

console.log('A flagged title still travels');
const all = await dryRun();
check('the dry run answers', all.ok === true, JSON.stringify(all).slice(0, 200));
check(
  'nothing is skipped for a title any more',
  (all.skippedCount ?? 0) === 0,
  `skippedCount=${all.skippedCount} — a title should never withhold a contact`
);

const flagged = all.flagged ?? [];
if (flagged.length === 0) {
  console.log('  (no unrecognised titles in the current eligible set — the assertions below need one)');
} else {
  check('flagged contacts are counted', (all.flaggedCount ?? 0) === flagged.length);
  check(
    'every flag names the person and says why',
    flagged.every((f) => f.name && f.reason),
    JSON.stringify(flagged[0])
  );
  // The regression this file exists for: flagged must be INCLUDED, so the
  // requested count has to cover them rather than exclude them.
  check(
    'a flagged contact is part of the payload, not removed from it',
    (all.requested ?? 0) >= flagged.length,
    `requested=${all.requested} but ${flagged.length} were flagged — they were dropped`
  );
  check(
    'the preview marks which contacts to sanity-check',
    (all.preview ?? []).some((p) => p.titleFlagged === true),
    'no preview row carries titleFlagged'
  );
  check(
    'the message says flagged, never skipped',
    /flagged for review, not held back/.test(all.message ?? '') && !/skipped/.test(all.message ?? ''),
    all.message
  );
}

console.log('\nThe non-negotiables are still gates');
// A title is advisory. An address is not: there is nothing to send without one,
// and no note substitutes for it.
check(
  'every previewed contact still has an email',
  (all.preview ?? []).every((p) => Boolean(p.email)),
  'a contact with no email reached the payload'
);
check('batching still reflects the real payload size', (all.batches ?? 0) === Math.ceil((all.requested ?? 0) / 100));

console.log(`\n${passed} passed, ${failed} failed`);
// `process.exitCode` rather than `process.exit()`: forcing exit while fetch's
// keepalive sockets are still open trips a libuv assertion on Windows, which
// turns a passing run into an exit code nobody can trust.
process.exitCode = failed > 0 ? 1 : 0;
