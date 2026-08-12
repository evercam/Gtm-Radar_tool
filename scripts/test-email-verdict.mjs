/**
 * Email verification precedence — Apollo's word against our own check.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-email-verdict.mjs
 *
 * Pure, so no database.
 *
 * The assertion that matters is the second block: a GUESSED address must not read
 * as verified even though our own check passes. A pattern-derived address sits on a
 * real company domain, so it sails through an MX lookup — which is the only check
 * running today, and is why 59 of 72 exported contacts were labelled verified on
 * the strength of their employer having a mail server.
 */

import { emailVerdict, normaliseApolloStatus } from '@/lib/enrich/emailVerdict';

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

// What validate.ts returns today with no Hunter key: an MX lookup on the domain.
const mxPass = { valid: true, confidence: 0.6, source: 'basic', domainExists: true };
const mxFail = { valid: false, confidence: 0, source: 'basic', domainExists: false };

console.log('Apollo status is read, not guessed at');
{
  check('verified', normaliseApolloStatus('verified') === 'verified');
  check('guessed', normaliseApolloStatus('guessed') === 'guessed');
  check('unverified is a guess by another name', normaliseApolloStatus('unverified') === 'guessed');
  check('likely is too', normaliseApolloStatus('likely') === 'guessed');
  check('unavailable', normaliseApolloStatus('unavailable') === 'unavailable');
  check('an absent field is unknown, not verified', normaliseApolloStatus(undefined) === 'unknown');
  check('and nonsense is unknown', normaliseApolloStatus(42) === 'unknown');
  check('case and padding do not matter', normaliseApolloStatus('  VERIFIED ') === 'verified');
}

console.log('\nA guessed address is never verified, however well the domain checks out');
{
  const v = emailVerdict('guessed', mxPass);
  check('guessed beats a passing MX check', v.verified === false, JSON.stringify(v));
  check('but keeps usable confidence', v.confidence > 0 && v.confidence < 0.5, String(v.confidence));
  check('and says why, in words a rep can act on', /company pattern/.test(v.reason), v.reason);
  check('the source names the decider', v.source === 'apollo_guessed', v.source);
}

console.log('\nApollo confirming a mailbox outranks an MX check');
{
  const v = emailVerdict('verified', mxPass);
  check('it verifies', v.verified === true);
  check('and scores above what an MX check can claim', v.confidence > mxPass.confidence, `${v.confidence} vs ${mxPass.confidence}`);

  /*
    Apollo says verified but the domain has no mail server. Something is wrong with
    one of the two, and claiming full confidence would hide the disagreement.
  */
  const conflict = emailVerdict('verified', mxFail);
  check('a domain conflict lowers confidence', conflict.confidence < v.confidence, `${conflict.confidence} vs ${v.confidence}`);
  check('and the conflict is stated', /no mail server/.test(conflict.reason), conflict.reason);
}

console.log('\nA real mailbox check wins outright, in both directions');
{
  const hunterOk = emailVerdict('guessed', { valid: true, confidence: 0.93, source: 'hunter' });
  check('hunter overrides Apollo guessed', hunterOk.verified === true && hunterOk.source === 'hunter', JSON.stringify(hunterOk));
  const hunterBad = emailVerdict('verified', { valid: false, confidence: 0, source: 'hunter' });
  check('and overrides Apollo verified', hunterBad.verified === false, JSON.stringify(hunterBad));
  check('naming the direct check as the reason', /not deliverable/.test(hunterBad.reason), hunterBad.reason);
}

console.log('\nWith nothing from Apollo, the verdict says only the domain was checked');
{
  const v = emailVerdict('unknown', mxPass);
  check('an MX pass still counts as valid', v.verified === true);
  check('but is honest about what it proved', /mailbox itself is unconfirmed/.test(v.reason), v.reason);
  check('and keeps the MX ceiling', v.confidence === 0.6, String(v.confidence));

  const none = emailVerdict('unknown', null);
  check('no check at all is not verified', none.verified === false && none.confidence === 0);
  check('and says no check ran', /No address check/.test(none.reason), none.reason);

  const fail = emailVerdict('unknown', mxFail);
  check('a failed domain check is not verified', fail.verified === false);
}

console.log('\nUnavailable means there is nothing to verify');
{
  const v = emailVerdict('unavailable', mxPass);
  check('it is not verified', v.verified === false);
  check('confidence is zero', v.confidence === 0);
  check('and it says Apollo has no address', /no address/i.test(v.reason), v.reason);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
