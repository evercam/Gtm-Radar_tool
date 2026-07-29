/**
 * Whether a webhook URL is one an external provider could actually reach.
 *
 * Apollo delivers revealed phone numbers asynchronously to a callback, and
 * charges 8 credits per mobile. Point it at localhost and the request is
 * accepted, the credits are spent, and the answer is delivered into a void —
 * so this is checked before a reveal is ever requested, and again when the
 * policy is saved.
 *
 * Pure and dependency-free: the policy validator, the reveal client and the
 * tests all need the same answer, and a second copy would eventually disagree
 * with the first.
 */
export function isDeliverableWebhook(url: string | null | undefined): boolean {
  if (!url?.trim()) return false;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:') return false;

    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;

    // Loopback and RFC1918 ranges are unreachable from a provider's network.
    if (/^127\./.test(host)) return false;
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    // 172.16.0.0–172.31.255.255 only; 172.15.x and 172.32.x are public.
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;

    return true;
  } catch {
    return false;
  }
}
