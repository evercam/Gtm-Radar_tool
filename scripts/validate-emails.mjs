/**
 * Validates email addresses already in the database.
 *
 * Records imported from a spreadsheet arrive with an address but no verdict on
 * it, so `email_verified` stays false and the Apollo export — which requires a
 * verified address — skips them. Re-running full enrichment would fix that and
 * would also pay Apollo and Anthropic again for contacts we already have.
 *
 * This does only the missing step. `validateEmail` needs no paid key: without
 * Hunter it falls back to format checks plus a live MX lookup on the domain,
 * which is free and catches the great majority of undeliverable addresses.
 *
 *   # see what would change, touching nothing
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *     --import ./scripts/lib/register-alias.mjs scripts/validate-emails.mjs
 *
 *   # write the results
 *   … scripts/validate-emails.mjs --apply
 */

const APPLY = process.argv.includes('--apply');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 1000);

const { validateEmail } = await import('../src/lib/enrich/validate.ts');
const { createClient } = await import('@supabase/supabase-js');

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await db
  .from('canonical_projects')
  .select('id, canonical_name, contact_name, contact_email, email_verified, email_confidence')
  .not('contact_email', 'is', null)
  .or('email_verified.is.null,email_verified.eq.false')
  .limit(LIMIT);

if (error) {
  console.error('Could not read records:', error.message);
  process.exit(1);
}

const rows = data ?? [];
console.log(`${rows.length} address${rows.length === 1 ? '' : 'es'} to check${APPLY ? '' : ' (dry run)'}\n`);
if (rows.length === 0) process.exit(0);

const tally = { valid: 0, invalid: 0, unknown: 0, role: 0, failed: 0 };
const reasons = new Map();
let updated = 0;

for (const r of rows) {
  let v;
  try {
    v = await validateEmail(r.contact_email);
  } catch (e) {
    tally.failed += 1;
    console.log(`  ERR   ${r.contact_email} — ${e.message}`);
    continue;
  }

  // Three outcomes. An address we could not check must never be written as
  // invalid: that turns a temporary failure into a permanent verdict and
  // silently removes the record from every future export.
  const inconclusive = /could not check/i.test(v.reason ?? '');
  if (v.valid) tally.valid += 1;
  else if (inconclusive) tally.unknown += 1;
  else {
    tally.invalid += 1;
    const why = v.reason ?? 'not deliverable';
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }
  if (v.roleBased) tally.role += 1;

  const mark = v.valid ? 'VALID  ' : inconclusive ? 'unknown' : 'invalid';
  console.log(
    `  ${mark} ${String(r.contact_email).padEnd(38)} ${Math.round(v.confidence * 100)}%` +
      `${v.roleBased ? ' (role address)' : ''}${v.valid ? '' : ' — ' + (v.reason ?? 'not deliverable')}`
  );

  if (APPLY && !inconclusive) {
    // Confidence is written alongside the flag: "verified" on its own cannot
    // distinguish a personal address that resolved cleanly from a catch-all
    // domain that accepts anything.
    const { error: upErr } = await db
      .from('canonical_projects')
      .update({ email_verified: v.valid, email_confidence: v.confidence })
      .eq('id', r.id);
    if (upErr) console.log(`         ! could not save: ${upErr.message}`);
    else updated += 1;
  }
}

console.log(
  `\n${tally.valid} valid, ${tally.invalid} invalid, ${tally.unknown} not checked, ${tally.role} role addresses, ${tally.failed} errored`
);

if (tally.unknown > 0) {
  console.log(
    `\n${tally.unknown} address${tally.unknown === 1 ? ' was' : 'es were'} left untouched because the check could not complete.`
  );
  console.log('  DNS is not answering. Nothing was marked bad on the strength of a failed lookup.');
}
if (reasons.size) {
  console.log('\nwhy the invalid ones failed:');
  for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${why}`);
}

if (!APPLY) {
  console.log('\nNothing was written. Re-run with --apply to save these results.');
} else {
  console.log(`\n${updated} record(s) updated.`);
  console.log(`${tally.valid} are now exportable to Apollo, once they have an owner.`);
}

// A role address (info@, sales@) is deliverable but is not a person. Left
// verified because it IS reachable — worth knowing before anyone dials it.
if (tally.role > 0) {
  console.log(
    `\nNote: ${tally.role} of these are role addresses (info@, sales@…). Deliverable, but nobody's personal inbox.`
  );
}
