/**
 * Posts one real message to a Zoho Cliq webhook, to prove the URL works.
 *
 * Run this BEFORE saving the URL in Settings. A wrong URL is accepted by our code
 * and rejected by Cliq, and the only way to tell the difference is to send
 * something and read the answer — which is exactly what an export cannot do for
 * you, because it fires the notice after the send is already durable.
 *
 * With the URL on the command line (nothing is stored):
 *
 *   CLIQ_WEBHOOK_URL='https://cliq.zoho.com/...zapikey=...' \
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-cliq.mjs
 *
 * Or, once it is saved in Settings, with no argument at all — it reads the stored
 * secret and sends through the same code path a real export uses:
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-cliq.mjs
 *
 * The message is clearly marked as a test so nobody reads it as a real handover.
 */

import { formatExportNotice, notifyExportFinished } from '@/lib/notify/cliq';
import { isDeliverableWebhook } from '@/lib/enrich/webhookTarget';

const sample = {
  requested: 12,
  created: 10,
  existing: 2,
  failed: 0,
  perAssignee: [
    { name: 'Anas Filali', count: 8 },
    { name: 'Ronniel Manalo', count: 4 },
  ],
  atQuota: ['Ronniel Manalo'],
  flagged: 1,
  ownerOrListFailed: 0,
  trigger: 'manual',
  assignee: null,
  durationMs: 8379,
};

const override = process.env.CLIQ_WEBHOOK_URL?.trim();

console.log('This is what a real export will post:\n');
console.log(
  formatExportNotice(sample)
    .split('\n')
    .map((l) => '  │ ' + l)
    .join('\n')
);
console.log();

if (override) {
  // Explicit URL: post directly rather than through the stored secret, so this
  // can validate a URL that has not been saved anywhere yet.
  if (!isDeliverableWebhook(override)) {
    console.error('That URL will never deliver. It must be https, and not localhost or a private range.');
    process.exitCode = 1;
  } else {
    const text = `🧪 *TEST from the LDR tool* — not a real export.\n\n${formatExportNotice(sample)}`;
    try {
      const res = await fetch(override, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, card: { title: 'LDR — webhook test', theme: 'modern-inline' } }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.text().catch(() => '');
      if (res.ok) {
        console.log(`Cliq accepted it — HTTP ${res.status}. Check the chat; the message should be there.`);
        console.log(`\nSave it with:\n  node --env-file=.env.local --experimental-transform-types --no-warnings \\\n    --import ./scripts/lib/register-alias.mjs scripts/set-secret.mjs cliq_webhook_url`);
      } else {
        console.error(`Cliq rejected it — HTTP ${res.status}`);
        console.error(`  ${body.slice(0, 400)}`);
        console.error('\n401/403 usually means the zapikey is wrong or missing; 404 means the bot or channel name is.');
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(`Could not reach Cliq: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
} else {
  // No URL given: exercise the stored secret through the real notifier, so this
  // reports exactly what an export would report.
  const result = await notifyExportFinished(sample);
  if (result.sent) {
    console.log('Sent via the stored secret. Check the chat.');
  } else if (result.reason === 'not-configured') {
    console.log('No Cliq webhook is stored yet.');
    console.log('Pass one to test it first:  CLIQ_WEBHOOK_URL=\'https://…\' node … scripts/test-cliq.mjs');
    console.log('Or save it:  node … scripts/set-secret.mjs cliq_webhook_url');
  } else {
    console.error(`Not sent — ${result.reason}${result.detail ? `: ${result.detail}` : ''}`);
    process.exitCode = 1;
  }
}
