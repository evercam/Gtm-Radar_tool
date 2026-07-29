import 'server-only';
import { promises as dns } from 'node:dns';
import { readSecret } from '@/lib/crypto/store';

/**
 * Contact validation.
 *
 * A lead is only workable through the channel its lane uses: Act Now is a
 * phone motion, Nurture is an email motion. Handing a seller a record whose
 * required channel is missing or bogus wastes their time, so enrichment
 * validates before promoting.
 *
 * Every validator degrades: with no Hunter or Twilio key configured the basic
 * checks still run (format, MX, role-address detection), and the result is
 * marked with which source produced it so a regex pass is never mistaken for a
 * verified one. Confidence reflects that difference.
 */

export interface EmailValidation {
  valid: boolean;
  confidence: number; // 0..1
  roleBased: boolean; // info@, sales@ — deliverable but not a person
  domainExists: boolean;
  source: 'hunter' | 'basic';
  reason?: string;
}

export interface PhoneValidation {
  valid: boolean;
  confidence: number;
  type: 'mobile' | 'landline' | 'voip' | 'unknown';
  source: 'twilio' | 'basic';
  reason?: string;
}

// Deliberately not RFC 5322 — that regex accepts addresses no mail system
// routes. This is the pragmatic subset every provider actually supports.
const EMAIL_SHAPE = /^[^\s@,;:<>()[\]\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Addresses that reach a team inbox rather than a named human. */
const ROLE_PREFIXES = [
  'info',
  'sales',
  'support',
  'contact',
  'admin',
  'hello',
  'enquiries',
  'enquiry',
  'office',
  'help',
  'team',
  'marketing',
  'noreply',
  'no-reply',
  'mail',
  'general',
  'accounts',
  'billing',
  'careers',
  'jobs',
  'press',
  'media',
  'legal',
  'privacy',
];

/** Placeholder addresses vendors return when a real one isn't unlocked. */
const PLACEHOLDER = /email_not_unlocked|not_unlocked|@domain\.com$|@example\.(com|org)$|@test\./i;

export function isRoleAddress(email: string): boolean {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  return ROLE_PREFIXES.some((p) => local === p || local.startsWith(`${p}.`) || local.startsWith(`${p}-`));
}

/**
 * Whether the domain can receive mail.
 *
 * Three outcomes, not two. "No MX record" and "the lookup did not complete"
 * are different facts and must not be collapsed: a resolver that is down or
 * misconfigured would otherwise mark every address in the database
 * undeliverable, which is both wrong and hard to notice — the run looks like it
 * worked and reports a plausible number.
 *
 * Tried over HTTPS first. The system resolver is not always reachable (a
 * container with no DNS of its own, a host pointing at 127.0.0.1 with nothing
 * listening), whereas outbound HTTPS is the one thing this app already depends
 * on everywhere else.
 */
type MxResult = 'yes' | 'no' | 'unknown';

const mxCache = new Map<string, MxResult>();

async function mxOverHttps(domain: string): Promise<MxResult> {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return 'unknown';
    const json = (await res.json()) as { Status?: number; Answer?: { type: number }[] };
    // Status 3 is NXDOMAIN — an authoritative "this domain does not exist".
    if (json.Status === 3) return 'no';
    if (json.Status !== 0) return 'unknown';
    const mx = (json.Answer ?? []).filter((a) => a.type === 15);
    return mx.length > 0 ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

async function domainHasMx(domain: string): Promise<MxResult> {
  const key = domain.toLowerCase();
  const cached = mxCache.get(key);
  if (cached !== undefined) return cached;

  let result = await mxOverHttps(key);

  if (result === 'unknown') {
    try {
      const records = await dns.resolveMx(key);
      result = records.length > 0 ? 'yes' : 'no';
    } catch (e) {
      const code = (e as { code?: string }).code;
      // Only these two mean the domain genuinely has no mail exchanger.
      // ECONNREFUSED, ETIMEOUT, ESERVFAIL and friends mean we failed to ask.
      result = code === 'ENOTFOUND' || code === 'ENODATA' ? 'no' : 'unknown';
    }
  }

  // An inconclusive answer is not cached — the next attempt may reach a
  // resolver, and caching it would poison the whole run.
  if (result !== 'unknown') mxCache.set(key, result);
  return result;
}

/**
 * Validates an email. Uses Hunter when a key is configured, otherwise format
 * plus a live MX lookup, which catches the majority of bad addresses for free.
 */
export async function validateEmail(email: string | null | undefined): Promise<EmailValidation> {
  const base: EmailValidation = {
    valid: false,
    confidence: 0,
    roleBased: false,
    domainExists: false,
    source: 'basic',
  };

  if (!email?.trim()) return { ...base, reason: 'No email address' };
  const value = email.trim().toLowerCase();

  if (PLACEHOLDER.test(value)) return { ...base, reason: 'Vendor placeholder address' };
  if (!EMAIL_SHAPE.test(value)) return { ...base, reason: 'Malformed address' };

  const domain = value.split('@')[1];
  const roleBased = isRoleAddress(value);

  const hunterKey = await readSecret('hunter_api_key');
  if (hunterKey) {
    try {
      const res = await fetch(
        `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(value)}&api_key=${encodeURIComponent(hunterKey)}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (res.ok) {
        const json = (await res.json()) as { data?: { status?: string; score?: number; mx_records?: boolean } };
        const status = json.data?.status ?? 'unknown';
        const score = typeof json.data?.score === 'number' ? json.data.score / 100 : 0.5;
        return {
          valid: status === 'valid' || status === 'accept_all',
          confidence: score,
          roleBased,
          domainExists: json.data?.mx_records ?? true,
          source: 'hunter',
          reason: status,
        };
      }
    } catch {
      // Fall through to the basic check — a validator outage must not block
      // enrichment, it just lowers the confidence we can claim.
    }
  }

  const mx = await domainHasMx(domain);
  const domainExists = mx === 'yes';
  return {
    // Unknown is NOT valid, but it is also not a verdict — the caller must be
    // able to tell "we checked and it is bad" from "we could not check".
    valid: mx === 'yes',
    confidence: mx === 'yes' ? (roleBased ? 0.45 : 0.6) : 0,
    roleBased,
    domainExists,
    source: 'basic',
    reason:
      mx === 'yes'
        ? 'Format and MX verified'
        : mx === 'no'
          ? 'Domain cannot receive mail'
          : 'Could not check — no DNS answer',
  };
}

/** Digits only, for length checks. */
function digitsOf(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Validates a phone number. Uses Twilio Lookup when configured, otherwise a
 * shape and length check — which is enough to reject the obvious placeholders
 * and truncated values vendors return.
 */
export async function validatePhone(phone: string | null | undefined): Promise<PhoneValidation> {
  const base: PhoneValidation = { valid: false, confidence: 0, type: 'unknown', source: 'basic' };

  if (!phone?.trim()) return { ...base, reason: 'No phone number' };

  const raw = phone.trim();
  const digits = digitsOf(raw);

  // E.164 allows 7–15 digits. Anything outside that is not a routable number.
  if (digits.length < 7 || digits.length > 15) {
    return { ...base, reason: `Implausible length (${digits.length} digits)` };
  }
  // All-same or sequential digits are placeholders, not numbers.
  if (/^(\d)\1+$/.test(digits) || digits === '1234567890') {
    return { ...base, reason: 'Placeholder number' };
  }

  const twilioToken = await readSecret('twilio_auth_token');
  if (twilioToken) {
    try {
      // Twilio Lookup wants E.164; assume a leading + when one is absent.
      const e164 = raw.startsWith('+') ? raw : `+${digits}`;
      const res = await fetch(
        `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`,
        {
          headers: { Authorization: `Basic ${Buffer.from(`:${twilioToken}`).toString('base64')}` },
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (res.ok) {
        const json = (await res.json()) as {
          valid?: boolean;
          line_type_intelligence?: { type?: string };
        };
        const lineType = json.line_type_intelligence?.type ?? '';
        const type: PhoneValidation['type'] = lineType.includes('mobile')
          ? 'mobile'
          : lineType.includes('landline') || lineType.includes('fixed')
            ? 'landline'
            : lineType.includes('voip')
              ? 'voip'
              : 'unknown';
        return {
          valid: Boolean(json.valid),
          confidence: json.valid ? 0.95 : 0,
          type,
          source: 'twilio',
        };
      }
    } catch {
      // Fall through to the basic result.
    }
  }

  return {
    valid: true,
    // Shape alone is weak evidence — it proves the number could exist, not that
    // it does. Kept well below what Twilio can assert.
    confidence: 0.4,
    type: 'unknown',
    source: 'basic',
    reason: 'Format check only',
  };
}

export interface ChannelValidation {
  email: EmailValidation | null;
  phone: PhoneValidation | null;
  /** Whether the record now carries a usable value on its required channel. */
  satisfied: boolean;
  missing: string[];
}

/**
 * Validates whatever the record has, against what its lane requires.
 *
 * `channel` comes from lib/lifecycle's `requiredChannel(stage)`. A record that
 * fails this stays queued rather than being promoted to a seller.
 */
export async function validateForChannel(
  channel: 'phone' | 'email' | 'both' | 'any' | 'none',
  contact: { email?: string | null; phone?: string | null }
): Promise<ChannelValidation> {
  const needEmail = channel === 'email' || channel === 'both';
  const needPhone = channel === 'phone' || channel === 'both';

  const [email, phone] = await Promise.all([
    needEmail || channel === 'any' || contact.email ? validateEmail(contact.email) : Promise.resolve(null),
    needPhone || channel === 'any' || contact.phone ? validatePhone(contact.phone) : Promise.resolve(null),
  ]);

  // `any` is satisfied by whichever channel validates — the lane can be worked
  // either way, so insisting on a particular one would hold a workable lead.
  if (channel === 'any') {
    const satisfied = Boolean(email?.valid || phone?.valid);
    return { email, phone, satisfied, missing: satisfied ? [] : ['phone or email'] };
  }

  const missing: string[] = [];
  if (needEmail && !email?.valid) missing.push('email');
  if (needPhone && !phone?.valid) missing.push('phone');

  return { email, phone, satisfied: missing.length === 0, missing };
}
