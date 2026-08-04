import 'server-only';
import { readSecret } from '@/lib/crypto/store';
import { isDeliverableWebhook } from '@/lib/enrich/webhookTarget';

/**
 * Telling the team an export happened, in the chat they already sit in.
 *
 * Apollo does not notify on contact creation. Its notification feed carries
 * account-admin nudges (`unoccupied_seats_nudge`, `user_crm_not_connected`) and
 * nothing else — a verified read of the live workspace returned two, both to the
 * billing owner, none to any BDR. So a run that sent 40 leads and a run nobody
 * triggered look exactly the same from inside Apollo, and the only place the
 * difference can surface is here.
 *
 * The message answers the one question worth asking after a run: WHO got how
 * many. A total is not actionable — "12 leads went out" does not tell a BDR to
 * open their list, and does not tell a manager whose quota is binding.
 *
 * Best-effort by construction. The export has already written to Apollo and to
 * `export_runs` by the time this runs, so a failed notice must never turn a
 * successful export into a failed request: every path returns a result instead
 * of throwing, and the caller reports it rather than acting on it.
 */

export interface ExportNotice {
  /** Contacts actually sent (not leads — a committee is several contacts). */
  requested: number;
  created: number;
  existing: number;
  failed: number;
  /** Leads per person, already trimmed to each quota. */
  perAssignee: { name: string; count: number }[];
  /** Names held back because their daily quota was already spent. */
  atQuota: string[];
  /** Titles the persona guide did not recognise — sent, but worth a glance. */
  flagged: number;
  /** Contacts in Apollo that could not be given an owner or a list. */
  ownerOrListFailed: number;
  /** 'manual' or 'cron' — a scheduled run reads differently from a deliberate one. */
  trigger: string;
  /** Present when the run was scoped to one person. */
  assignee?: string | null;
  durationMs: number;
}

export type NoticeResult =
  | { sent: true }
  | { sent: false; reason: 'not-configured' | 'unreachable-url' | 'rejected' | 'error'; detail?: string };

/** The human-readable body. Exported so a test can assert it without a network. */
export function formatExportNotice(n: ExportNotice): string {
  const scope = n.assignee ? ` for ${n.assignee}` : '';
  const how = n.trigger === 'cron' ? 'Scheduled export' : 'Export';

  // Leading with the per-person split rather than the total, because that is
  // what makes it a notification someone acts on rather than a statistic.
  const split = n.perAssignee.length
    ? n.perAssignee.map((p) => `${p.name} ${p.count}`).join(' · ')
    : 'nobody — nothing was eligible';

  const lines = [
    `*${how}${scope} — ${n.requested} contact${n.requested === 1 ? '' : 's'} to Apollo*`,
    split,
    `${n.created} created · ${n.existing} already there${n.failed ? ` · ${n.failed} failed` : ''}`,
  ];

  // Only the things that need a human. A clean run stays three lines.
  if (n.atQuota.length) lines.push(`Held back at daily quota: ${n.atQuota.join(', ')}`);
  if (n.flagged) lines.push(`${n.flagged} title${n.flagged === 1 ? '' : 's'} flagged for review — sent, not held back`);
  if (n.ownerOrListFailed) lines.push(`⚠ ${n.ownerOrListFailed} in Apollo without an owner or list`);

  lines.push(`_took ${(n.durationMs / 1000).toFixed(1)}s_`);
  return lines.join('\n');
}

/**
 * Posts the notice to the Cliq bot.
 *
 * The whole incoming-webhook URL is the secret, zapikey included — the same
 * shape Cliq hands out, so there is nothing to reassemble and no second field to
 * get out of step with the first.
 */
export async function notifyExportFinished(
  notice: ExportNotice,
  options: { url?: string | null; prefix?: string } = {}
): Promise<NoticeResult> {
  let url: string | null = null;
  if (options.url?.trim()) {
    // An explicit URL is how Settings tests a value that has not been saved yet.
    // Pasting a URL, saving it, discovering it is wrong and clearing it again is
    // three round trips to learn one fact.
    url = options.url;
  } else {
    try {
      url = await readSecret('cliq_webhook_url');
    } catch {
      return { sent: false, reason: 'error', detail: 'could not read the webhook secret' };
    }
  }

  // Not configured is the normal state until someone pastes a URL, so it is a
  // reported outcome rather than a warning.
  if (!url?.trim()) return { sent: false, reason: 'not-configured' };

  // A localhost or RFC1918 URL is accepted by nothing and delivered nowhere.
  // Same check the Apollo phone callback uses, for the same reason.
  if (!isDeliverableWebhook(url)) return { sent: false, reason: 'unreachable-url' };

  // A test message must be unmistakably a test. An unlabelled sample landing in
  // the team channel reads as a real handover of leads nobody was given.
  const text = options.prefix ? `${options.prefix}\n\n${formatExportNotice(notice)}` : formatExportNotice(notice);

  try {
    const res = await fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Cliq takes `text` for the message. A card gives it a title row in the
      // channel; both are plain fields, so this degrades to text if the bot has
      // cards disabled.
      body: JSON.stringify({ text, card: { title: 'LDR — Apollo export', theme: 'modern-inline' } }),
      // Short: this runs after the export is already durable, and nobody should
      // wait on a chat message.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, reason: 'rejected', detail: `HTTP ${res.status} ${body.slice(0, 120)}`.trim() };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}
