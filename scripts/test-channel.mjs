/**
 * Channel readiness — against the REAL src/lib/lifecycle.ts.
 *
 * This gate decides whether an enriched record can ever be assigned, so it is
 * the narrowest point in the pipeline. It was set to demand BOTH a phone and
 * an email for the qualify lane, which held 3,383 leads behind a second
 * channel nobody needed to make the call. The business rule is simpler:
 * sales works the phone, marketing works email.
 *
 *   node --experimental-transform-types scripts/test-channel.mjs
 */

import { requiredChannel, channelReadiness } from '../src/lib/lifecycle.ts';

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  PASS ${n}`); } else { failed++; console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`); } };
const group = (n) => console.log(`\n${n}`);
const rec = (o) => channelReadiness(o);

group('Each lane asks for the channel it is worked through');
check('act_now wants a phone', requiredChannel('act_now') === 'phone');
check('qualify wants a phone — sales is a phone motion', requiredChannel('qualify') === 'phone');
check('nurture wants an email', requiredChannel('nurture') === 'email');
check('hold asks for nothing', requiredChannel('hold') === 'none');
check('an unknown stage asks for nothing', requiredChannel('somewhere') === 'none');
check('a null stage asks for nothing', requiredChannel(null) === 'none');

group('A phone is enough for sales');
check('act_now with only a phone passes', rec({ stage: 'act_now', contact_phone: '+353 1 555 0100' }).satisfied);
check('qualify with only a phone passes', rec({ stage: 'qualify', contact_phone: '+1 208 368 4000' }).satisfied);
check('qualify with only an email is held', !rec({ stage: 'qualify', contact_email: 'a@b.com' }).satisfied);
check('qualify names what is missing', rec({ stage: 'qualify', contact_email: 'a@b.com' }).missing.join() === 'phone');
check('both is still fine', rec({ stage: 'qualify', contact_phone: '+1 555', contact_email: 'a@b.com' }).satisfied);

group('An email is enough for nurture');
check('nurture with only an email passes', rec({ stage: 'nurture', contact_email: 'a@b.com' }).satisfied);
check('nurture with only a phone is held', !rec({ stage: 'nurture', contact_phone: '+1 555' }).satisfied);
check('nurture names what is missing', rec({ stage: 'nurture', contact_phone: '+1 555' }).missing.join() === 'email');

group('Nothing at all is never ready');
check('act_now with no contact', !rec({ stage: 'act_now' }).satisfied);
check('qualify with no contact', !rec({ stage: 'qualify' }).satisfied);
check('nurture with no contact', !rec({ stage: 'nurture' }).satisfied);
check('an empty-string phone does not count', !rec({ stage: 'act_now', contact_phone: '' }).satisfied);
check('a null email does not count', !rec({ stage: 'nurture', contact_email: null }).satisfied);

group('Parked leads are not gated');
check('hold passes with nothing', rec({ stage: 'hold' }).satisfied);
check('disqualify passes with nothing', rec({ stage: 'disqualify' }).satisfied);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
