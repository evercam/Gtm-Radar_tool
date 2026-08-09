/**
 * One reachability rule, shared by the export and the dashboard.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-reachability.mjs
 *
 * This existed twice and the two copies disagreed, which is the only reason the
 * file is here. The export asked the policy's channelRules what a lead's lane
 * needs and counted the whole committee; the handover dashboard asked whether
 * `contact_email` was set. On live data the dashboard reported 96 leads waiting
 * and 0 ready while the export could send 47.
 *
 * Getting it right needs BOTH halves, and the first attempt at the fix had only
 * one — the channel rule — which flipped the same page from 0 to 96. This
 * workspace runs the `qualify` lane at channel 'none', so a channel-only test
 * passes every record including ones carrying no contacts at all.
 *
 * Pure — no network, no database.
 */

import { laneChannel, personReachable, recordReachable } from '@/lib/export/reachability';

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

// The rules this workspace actually runs, read off the live policy.
const RULES = { act_now: 'phone', qualify: 'none', nurture: 'email' };

console.log('The lane decides what "reachable" means');
{
  check('act_now wants a phone', laneChannel(RULES, 'act_now') === 'phone');
  check('qualify wants nothing', laneChannel(RULES, 'qualify') === 'none');
  check('nurture wants an email', laneChannel(RULES, 'nurture') === 'email');
  /*
    An unwritten lane falls back to 'any', the permissive reading. The
    alternative is silently dropping a lead because nobody has written a rule
    for its lane yet.
  */
  check('an unknown lane falls back to any', laneChannel(RULES, 'brand_new') === 'any');
  check('a null lane falls back to any', laneChannel(RULES, null) === 'any');
}

console.log('\nA person against a channel');
{
  const p = { email: 'a@b.com', phone: null };
  const q = { email: null, phone: '+1555' };
  check('email lane accepts an address', personReachable('email', p));
  check('email lane refuses a number', !personReachable('email', q));
  check('phone lane accepts a number', personReachable('phone', q));
  check('phone lane refuses an address', !personReachable('phone', p));
  check('both wants both', !personReachable('both', p) && personReachable('both', { email: 'a@b', phone: '1' }));
  check('any takes either', personReachable('any', p) && personReachable('any', q));
  check('none takes nobody at all', personReachable('none', { email: null, phone: null }));
}

console.log('\nA record needs a channel AND somebody worth sending');
{
  const co = 'Brasfield & Gorrie';

  // The case that broke it: lane 'none' satisfies the channel for everyone.
  check(
    'no contacts at all is not exportable, even on a none lane',
    !recordReachable({ stage: 'qualify', company_name_raw: co }, RULES)
  );
  check(
    'a named contact with no channel IS exportable on a none lane',
    recordReachable({ stage: 'qualify', contact_name: 'Bruce Wayne', company_name_raw: co }, RULES)
  );
  /*
    A nameless contact carrying a number is worth having — the export names it
    "{company} — Main Line" rather than inventing a person or throwing the number
    away. But it needs the company to name it after.
  */
  check(
    'a nameless number with a company is exportable',
    recordReachable({ stage: 'qualify', contact_phone: '+1555', company_name_raw: co }, RULES)
  );
  check(
    'a nameless number with no company is not',
    !recordReachable({ stage: 'qualify', contact_phone: '+1555' }, RULES)
  );

  // The committee counts as much as the primary contact — missing this once made
  // Brasfield's thirteen contacts invisible to the export gate.
  check(
    'a colleague can carry the record',
    recordReachable(
      { stage: 'act_now', contact_name: 'Bruce', additional_contacts: [{ name: 'Alfred', phone: '+1555' }], company_name_raw: co },
      RULES
    )
  );
  check(
    'but only if the colleague meets the lane',
    !recordReachable(
      { stage: 'act_now', contact_name: 'Bruce', additional_contacts: [{ name: 'Alfred', email: 'a@b.com' }], company_name_raw: co },
      RULES
    ),
    'act_now needs a phone'
  );
  check(
    'a non-array committee does not throw',
    !recordReachable({ stage: 'qualify', additional_contacts: 'nope', company_name_raw: co }, RULES)
  );
}

console.log('\nThe lanes behave differently, which is the whole point');
{
  const phoneOnly = { contact_name: 'Bruce', contact_phone: '+1555', company_name_raw: 'X' };
  check('phone-only is exportable in act_now', recordReachable({ ...phoneOnly, stage: 'act_now' }, RULES));
  check('phone-only is NOT exportable in nurture', !recordReachable({ ...phoneOnly, stage: 'nurture' }, RULES));
  /*
    This is the disagreement that started it: a phone-only lead was counted as
    "waiting on contact" by the dashboard while the export would have sent it.
  */
  check('and the old email-only test would have refused it', !phoneOnly.contact_email);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
