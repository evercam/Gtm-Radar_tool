/**
 * Phone-reveal guards — against the REAL src/lib/enrich/apolloPhone.ts.
 *
 * Apollo delivers revealed numbers to a webhook, asynchronously, and charges
 * 8 credits per mobile. Both facts make the webhook check load-bearing: point
 * it at localhost and Apollo accepts the request, bills the credits, and
 * delivers the answer into a void. So the rule is that a webhook must be
 * demonstrably reachable from the public internet before a single reveal is
 * requested.
 *
 *   node --experimental-transform-types scripts/test-phone-reveal.mjs
 */

import { isDeliverableWebhook } from '../src/lib/enrich/webhookTarget.ts';

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

group('A reachable webhook is accepted');
check('public https host', isDeliverableWebhook('https://leads.evercam.io/api/webhooks/apollo/phone'));
check('with a query string', isDeliverableWebhook('https://leads.evercam.io/api/webhooks/apollo/phone?token=abc'));
check('a public IP over https', isDeliverableWebhook('https://93.184.216.34/hook'));
check('a non-standard port is fine', isDeliverableWebhook('https://leads.evercam.io:8443/hook'));

group('Anything Apollo cannot reach is refused before credits are spent');
check('localhost', !isDeliverableWebhook('https://localhost:3000/hook'));
check('127.0.0.1', !isDeliverableWebhook('https://127.0.0.1/hook'));
check('10.x private range', !isDeliverableWebhook('https://10.1.2.3/hook'));
check('192.168.x private range', !isDeliverableWebhook('https://192.168.0.10/hook'));
check('172.16.x private range', !isDeliverableWebhook('https://172.16.4.5/hook'));
check('172.31.x — top of the private range', !isDeliverableWebhook('https://172.31.255.254/hook'));
check('a .local mDNS name', !isDeliverableWebhook('https://mac-mini.local/hook'));
check('a .internal name', !isDeliverableWebhook('https://api.internal/hook'));

group('172.32+ is public and must NOT be caught by the private-range check');
check('172.32.x is allowed', isDeliverableWebhook('https://172.32.0.1/hook'));
check('172.15.x is allowed', isDeliverableWebhook('https://172.15.0.1/hook'));

group('Plain HTTP is refused — Apollo requires HTTPS');
check('http is rejected', !isDeliverableWebhook('http://leads.evercam.io/hook'));
check('http on a public host is still rejected', !isDeliverableWebhook('http://93.184.216.34/hook'));

group('Nothing configured means nothing requested');
check('empty string', !isDeliverableWebhook(''));
check('whitespace', !isDeliverableWebhook('   '));
check('null', !isDeliverableWebhook(null));
check('undefined', !isDeliverableWebhook(undefined));
check('not a URL at all', !isDeliverableWebhook('evercam.io/hook'));
check('a bare hostname', !isDeliverableWebhook('leads.evercam.io'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
