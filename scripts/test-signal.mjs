/**
 * Signal strength — how well-evidenced a lead is, not how valuable.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-signal.mjs
 *
 * Pure, so no database.
 *
 * The property that matters most is the one in the first block: a record with a
 * high priority score and no evidence must NOT grade well. That is the whole
 * reason this exists — priority_score already rates a large owner highly on value,
 * ICP and key-account whether or not anybody knows a single fact about the project.
 */

import { assessSignal, SIGNAL_BANDS, SIGNAL_BAND_ORDER } from '@/lib/signal';

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

const day = (offsetMonths) => new Date(Date.now() + offsetMonths * 30.44 * 86400000).toISOString().slice(0, 10);

console.log('A headline with nothing behind it does not grade well');
{
  // Exactly the shape that scores P1 on value and ICP while nobody knows anything.
  const headline = assessSignal({ canonical_name: 'Big Energy Project', record_type: 'project' });
  check('a bare record bands as none', headline.band === 'none', `${headline.band} ${headline.score}`);
  check('and scores below the weak floor', headline.score < SIGNAL_BANDS.weak, String(headline.score));
  check('and says research is needed', /needs research/.test(headline.summary), headline.summary);
  check('and names a weakest component', headline.weakest !== null && headline.weakest.key.length > 0);
}

console.log('\nA well-evidenced project grades strong');
{
  const solid = assessSignal({
    record_type: 'project',
    current_phase: 'Under construction',
    construction_start_date: day(-1),
    estimated_completion_date: day(18),
    announced_date: day(-2),
    estimated_value: 40_000_000,
    capacity_mw: 250,
    city: 'Phoenix',
    address_line1: '1 Site Road',
    project_url: 'https://example.com/project',
    description: 'A 250 MW build.',
    contact_email: 'a@b.com',
    contact_phone: '+1 555 000 1111',
    email_verified: true,
    phone_verified: true,
    trigger_event: 'Notice to proceed issued',
  });
  check('it bands strong', solid.band === 'strong', `${solid.band} ${solid.score}`);
  check('and quotes the arrival summary', solid.summary.length > 20, solid.summary);
  check('every component contributes', solid.components.length === 5);
  check('and the weights total 100', solid.components.reduce((n, c) => n + c.weight, 0) === 100);
}

console.log('\nA model-found schedule counts, but counts for less');
{
  const base = {
    record_type: 'project',
    current_phase: 'Under construction',
    construction_start_date: day(-1),
    city: 'Leeds',
  };
  const curated = assessSignal(base);
  const inferred = assessSignal({
    ...base,
    // What the brief writes when it resolves an undated record from a news article.
    field_provenance: {
      construction_start_date: { source: 'sdr_brief', basis: 'https://news.example/x' },
      current_phase: { source: 'sdr_brief', basis: 'https://news.example/x' },
    },
  });
  check('a curated schedule outscores an inferred one', curated.score > inferred.score, `${curated.score} vs ${inferred.score}`);
  /*
    But it must still beat knowing nothing. The brief resolving a date is the whole
    point of that step — discounting it to zero would make the work pointless.
  */
  const nothing = assessSignal({ record_type: 'project' });
  check('and an inferred one still beats nothing', inferred.score > nothing.score, `${inferred.score} vs ${nothing.score}`);
  check('the discount is named in the note', /brief rather than a source feed/.test(inferred.components[0].note), inferred.components[0].note);
}

console.log('\nThe weakest component is the one worth chasing');
{
  /*
    By weight LEFT ON THE TABLE, not raw strength. Recency is worth 12 and timing
    32, so a zero on recency matters less than a third-strength timing — advising
    somebody to fix the small one would be advice that cannot move the number.
  */
  const noContact = assessSignal({
    record_type: 'project',
    current_phase: 'Under construction',
    construction_start_date: day(-1),
    announced_date: day(-1),
    estimated_value: 1_000_000,
    city: 'Cork',
    project_url: 'https://x.example',
    description: 'x',
    capacity_mw: 10,
  });
  check('with everything but a contact, reachability is weakest', noContact.weakest.key === 'reachability', noContact.weakest.key);
  check('and says nobody is callable', /Nobody to call/.test(noContact.weakest.note), noContact.weakest.note);
}

console.log('\nBands and edges');
{
  check('the band order sorts best first', SIGNAL_BAND_ORDER.strong < SIGNAL_BAND_ORDER.moderate);
  check('and none sorts last', SIGNAL_BAND_ORDER.none === 3);

  // A score must never leave 0..100 whatever arrives.
  const odd = assessSignal({
    record_type: 'project',
    estimated_value: Number.MAX_SAFE_INTEGER,
    additional_contacts: [{}, {}, {}],
    announced_date: 'not-a-date',
  });
  check('a nonsense date does not break the score', odd.score >= 0 && odd.score <= 100, String(odd.score));
  check('a committee alone makes it contactable', odd.components.find((c) => c.key === 'reachability').strength > 0);

  // An account has no project to time, and must not be punished as if it did.
  const account = assessSignal({ record_type: 'account', contact_email: 'a@b.com', email_verified: true });
  check('a company record still scores', account.score > 0, String(account.score));
  check('and is not claimed to be strong', account.band !== 'strong', account.band);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
