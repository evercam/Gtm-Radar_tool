import type { ContactChannel } from '@/lib/lifecycle';

/**
 * Whether a lead can actually be reached, decided in ONE place.
 *
 * It was decided in two, and they disagreed. The export asks the enrichment
 * policy's `channelRules` what the lead's lane needs — with `act_now` set to
 * 'phone', a number is sufficient and an address is not required — and it counts
 * the whole committee, not just the primary contact. The handover dashboard
 * asked a simpler question: does `contact_email` exist?
 *
 * So the dashboard reported 96 leads "waiting on contact" and 0 ready, while the
 * export would have sent 41 of them — 32 reachable by phone and 9 through a
 * committee member. Measured on live data, 2026-08-09. A rep reading that page
 * was told their whole book was stuck.
 *
 * Both callers now use this, which is the only way the two numbers stay the same
 * number.
 */

export interface Reachable {
  email?: string | null;
  phone?: string | null;
}

/**
 * What this lane needs to reach somebody.
 *
 * An unknown stage falls back to 'any', which is the permissive reading — the
 * alternative is silently dropping a lead because nobody has written a rule for
 * its lane yet.
 */
export function laneChannel(channelRules: Record<string, ContactChannel>, stage: unknown): ContactChannel {
  return channelRules[String(stage ?? '')] ?? 'any';
}

/** Whether one person satisfies the lane's channel requirement. */
export function personReachable(channel: ContactChannel, person: Reachable): boolean {
  const hasEmail = Boolean(person.email);
  const hasPhone = Boolean(person.phone);
  switch (channel) {
    case 'email':
      return hasEmail;
    case 'phone':
      return hasPhone;
    case 'both':
      return hasEmail && hasPhone;
    case 'none':
      return true;
    default:
      return hasEmail || hasPhone;
  }
}

/** The shape the committee check needs off a canonical_projects row. */
export interface ReachableRecord {
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  additional_contacts?: unknown;
  company_name_raw?: string | null;
  stage?: unknown;
}

interface Person extends Reachable {
  name?: string | null;
}

/**
 * Whether the export would produce at least one contact from this record.
 *
 * Two conditions, and BOTH are needed — which is the part that is easy to get
 * wrong. The channel rule alone is not enough: this workspace runs the `qualify`
 * lane at `channel: 'none'`, meaning no address or number is required, so a
 * channel-only test passes every record including ones carrying no contacts at
 * all. Applied that way the dashboard reported 96 leads ready when the export
 * could send 47.
 *
 * So a person must ALSO be sendable, which mirrors what the export does:
 *
 *   - a named person is sendable;
 *   - a nameless one with a channel is sendable, and becomes
 *     "{company} — Main Line" so a switchboard is never mistaken for a person;
 *   - a nameless one with no channel is nothing, and is dropped.
 *
 * The committee counts as much as the primary contact — a record whose named
 * contact has neither address nor number is still exportable when a colleague on
 * the same account has one. Missing that is what made Brasfield's thirteen
 * contacts invisible to the export gate once before.
 */
export function recordReachable(record: ReachableRecord, channelRules: Record<string, ContactChannel>): boolean {
  const channel = laneChannel(channelRules, record.stage);
  const company = record.company_name_raw?.trim();

  const sendable = (p: Person | undefined | null): boolean => {
    if (!p) return false;
    const named = Boolean(p.name?.trim());
    // A nameless contact needs a channel AND a company to name the line after.
    if (!named && !((p.email || p.phone) && company)) return false;
    return personReachable(channel, { email: p.email, phone: p.phone });
  };

  if (sendable({ name: record.contact_name, email: record.contact_email, phone: record.contact_phone })) return true;

  const committee = Array.isArray(record.additional_contacts) ? (record.additional_contacts as Person[]) : [];
  return committee.some(sendable);
}
