/**
 * Provider failure classification — against the REAL src/lib/enrich/errors.ts.
 *
 * Two things have to be right. The message a person reads, because the raw SDK
 * body ("400 {\"type\":\"error\"...}") reads as an application bug rather than
 * a bill to pay. And the `fatal` flag, because it decides whether the batch
 * keeps going: mark a transient rate-limit fatal and one blip aborts the run;
 * miss a spent credit balance and the batch makes a hundred identical failing
 * calls, burning the daily cap to produce a hundred copies of one message.
 *
 *   node --experimental-transform-types scripts/test-enrich-errors.mjs
 */

import { classifyEnrichError } from '../src/lib/enrich/errors.ts';

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const group = (n) => console.log(`\n${n}`);

/** The exact shape the Anthropic SDK throws. */
const anthropicError = (status, message, type = 'invalid_request_error') =>
  Object.assign(
    new Error(`${status} ${JSON.stringify({ type: 'error', error: { type, message } })}`),
    { status }
  );

group('A spent credit balance is fatal and readable');
{
  const e = anthropicError(400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');
  const c = classifyEnrichError(e);
  check('classified as billing', c.kind === 'billing', c.kind);
  check('fatal — every remaining record fails the same way', c.fatal === true);
  check('the raw JSON envelope is gone', !c.message.includes('{"type"'), c.message);
  check('the provider wording survives', c.message.includes('credit balance is too low'));
  check('it says the queue is safe', /queue is unchanged/i.test(c.message));
  console.log(`       -> ${c.message}`);
}

group('A rejected key is fatal too, and points at the fix');
for (const [status, msg] of [
  [401, 'invalid x-api-key'],
  [403, 'Request not permitted'],
]) {
  const c = classifyEnrichError(anthropicError(status, msg));
  check(`${status}: classified as auth`, c.kind === 'auth', c.kind);
  check(`${status}: fatal`, c.fatal === true);
  check(`${status}: points at Settings`, /Settings/.test(c.message));
}

group('Transient failures must NOT abort the batch');
{
  const rate = classifyEnrichError(anthropicError(429, 'Number of requests has exceeded your rate limit'));
  check('rate limit is classified', rate.kind === 'rate_limit', rate.kind);
  check('rate limit is not fatal', rate.fatal === false);

  const timeout = classifyEnrichError(new Error('The operation timed out'));
  check('timeout is classified', timeout.kind === 'timeout', timeout.kind);
  check('timeout is not fatal', timeout.fatal === false);

  const reset = classifyEnrichError(new Error('fetch failed: ECONNRESET'));
  check('a dropped connection is not fatal', reset.fatal === false);

  const odd = classifyEnrichError(new Error('something unexpected'));
  check('an unrecognised error is not fatal', odd.kind === 'unknown' && odd.fatal === false);
  check('an unrecognised error keeps its text', odd.message === 'something unexpected');
}

group('402 Payment Required is billing whatever the wording');
{
  const c = classifyEnrichError(anthropicError(402, 'quota'));
  check('classified by status alone', c.kind === 'billing', c.kind);
  check('fatal', c.fatal === true);
}

group('Messages survive awkward payloads');
{
  const escaped = classifyEnrichError(anthropicError(400, 'Credit balance too low. See \\"Plans & Billing\\".'));
  check('escaped quotes do not truncate the message', escaped.message.includes('Plans & Billing'), escaped.message);

  const noJson = classifyEnrichError(new Error('credit balance is too low'));
  check('a plain string is still classified', noJson.kind === 'billing');

  const notAnError = classifyEnrichError('credit balance is too low');
  check('a thrown string is handled', notAnError.kind === 'billing');

  const nullish = classifyEnrichError(null);
  check('null does not throw', nullish.kind === 'unknown');

  const long = classifyEnrichError(new Error('x'.repeat(5000)));
  check('a huge message is truncated', long.message.length <= 300, String(long.message.length));
}

group('Apollo-style errors classify too');
{
  const c = classifyEnrichError(Object.assign(new Error('401 {"error":"Unauthorized","message":"invalid api key"}'), { status: 401 }));
  check('auth', c.kind === 'auth' && c.fatal === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
