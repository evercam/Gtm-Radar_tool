/**
 * The export tells somebody, because Apollo does not.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-export-notify.mjs
 *
 * Apollo raises no notification when contacts are created — a read of the live
 * workspace returned two notifications in total, both account-admin nudges to the
 * billing owner, none to any BDR. So a run that sent forty leads and a run nobody
 * triggered are indistinguishable from inside the CRM, and the Cliq notice is the
 * only thing that separates them.
 *
 * The rules that matter here are about NOT breaking the export. The notice fires
 * after Apollo and `export_runs` are already written, so every failure path must
 * return a result rather than throw: a chat outage costs a message, never a send.
 * No network is used except the deliberately-unreachable URL check.
 */

import { formatExportNotice, notifyExportFinished } from '@/lib/notify/cliq';
import { isDeliverableWebhook } from '@/lib/enrich/webhookTarget';

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

const base = {
  requested: 12,
  created: 10,
  existing: 2,
  failed: 0,
  perAssignee: [
    { name: 'Anas Filali', count: 8 },
    { name: 'Ronniel Manalo', count: 4 },
  ],
  atQuota: [],
  flagged: 0,
  ownerOrListFailed: 0,
  trigger: 'manual',
  assignee: null,
  durationMs: 8379,
};

console.log('The message answers "who got how many"');
{
  const m = formatExportNotice(base);
  // A total is not actionable. The per-person split is the reason this exists.
  check('names each person and their count', /Anas Filali 8/.test(m) && /Ronniel Manalo 4/.test(m), m);
  check('states the totals', /10 created/.test(m) && /2 already there/.test(m), m);
  check('a clean run says nothing about failures', !/failed/.test(m), m);
  check('reports how long it took', /8\.4s|8\.4 s/.test(m), m);
}

console.log('\nA scoped run and a scheduled run read differently');
{
  check('a targeted run names the person', /for Ronniel Manalo/.test(formatExportNotice({ ...base, assignee: 'Ronniel Manalo' })));
  check('a cron run says so', /Scheduled export/.test(formatExportNotice({ ...base, trigger: 'cron' })));
  check('a manual run does not claim to be scheduled', !/Scheduled/.test(formatExportNotice(base)));
}

console.log('\nThe things a human has to act on are stated');
{
  check('failures appear when there are any', /3 failed/.test(formatExportNotice({ ...base, failed: 3 })));
  check(
    'quota trimming is named, not implied',
    /Held back at daily quota: Ronniel Manalo/.test(formatExportNotice({ ...base, atQuota: ['Ronniel Manalo'] }))
  );
  check(
    'a flagged title says it was SENT, not withheld',
    /flagged for review — sent, not held back/.test(formatExportNotice({ ...base, flagged: 2 }))
  );
  check(
    'an unowned contact is called out',
    /without an owner or list/.test(formatExportNotice({ ...base, ownerOrListFailed: 4 }))
  );
}

console.log('\nAn empty run does not pretend somebody received leads');
{
  const m = formatExportNotice({ ...base, requested: 0, created: 0, existing: 0, perAssignee: [] });
  check('says nobody, rather than printing an empty list', /nobody/.test(m), m);
}

console.log('\nA broken notice never breaks the export');
{
  // The export is already durable when this runs, so the contract is: resolve.
  let threw = false;
  let result = null;
  try {
    result = await notifyExportFinished(base);
  } catch {
    threw = true;
  }
  check('notifyExportFinished never throws', !threw);
  check('it returns a result object', result !== null && typeof result?.sent === 'boolean', JSON.stringify(result));
  check(
    'an unconfigured webhook is a reported outcome, not an error',
    result?.sent === true || ['not-configured', 'unreachable-url', 'rejected', 'error'].includes(result?.reason),
    JSON.stringify(result)
  );
  if (result?.sent === false && result.reason === 'not-configured') {
    console.log('  (no Cliq webhook configured — that is the expected state until one is pasted in Settings)');
  }
}

console.log('\nAn undeliverable URL is refused before anything is posted');
{
  // Same guard the Apollo phone callback uses: a localhost webhook accepts the
  // request and delivers into a void.
  check('localhost is refused', !isDeliverableWebhook('https://localhost/hook'));
  check('http is refused', !isDeliverableWebhook('http://cliq.zoho.com/hook'));
  check('a private range is refused', !isDeliverableWebhook('https://10.0.0.5/hook'));
  check('a real Cliq URL is accepted', isDeliverableWebhook('https://cliq.zoho.com/api/v2/bots/x/incoming?zapikey=y'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
