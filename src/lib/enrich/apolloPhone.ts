import 'server-only';
import { readSecret } from '@/lib/crypto/store';
import { isDeliverableWebhook } from '@/lib/enrich/webhookTarget';

/**
 * Direct dials and mobiles from Apollo.
 *
 * Apollo's people SEARCH never returns a phone number — that is not a bug in
 * our adapter, it is how the product is priced. Numbers come only from the
 * enrichment endpoint with `reveal_phone_number`, and that carries two hard
 * consequences:
 *
 *   1. It costs 8 Apollo credits per mobile returned (against 1 for
 *      demographics or a work email), so it must never run implicitly.
 *   2. Apollo verifies numbers asynchronously and delivers them to a
 *      **publicly reachable HTTPS webhook** — it will not answer inline. On
 *      localhost there is nowhere to deliver to, so the request is refused
 *      here rather than spending credits on a result that cannot arrive.
 *
 * The synchronous response still carries the person's other fields, so a
 * reveal request is not wasted even before the webhook fires.
 */

const BASE = process.env.APOLLO_BASE_URL || 'https://api.apollo.io/api/v1';

export interface PhoneRevealRequest {
  /** Our record id, echoed back through the webhook so the result can be matched. */
  recordId: string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  domain?: string | null;
  organizationName?: string | null;
  linkedinUrl?: string | null;
}

export interface PhoneRevealOutcome {
  ok: boolean;
  /** Numbers Apollo returned inline, if any. Usually empty — they arrive by webhook. */
  phones: string[];
  message: string;
  /** True when the request was accepted and a webhook delivery is expected. */
  pending: boolean;
}

function collectPhones(person: Record<string, unknown> | undefined): string[] {
  if (!person) return [];
  const out: string[] = [];
  const list = person.phone_numbers;
  if (Array.isArray(list)) {
    for (const n of list as { sanitized_number?: string; raw_number?: string }[]) {
      const v = n.sanitized_number || n.raw_number;
      if (v) out.push(v);
    }
  }
  const org = person.organization as { phone?: string; sanitized_phone?: string } | undefined;
  const orgPhone = org?.sanitized_phone || org?.phone;
  if (orgPhone) out.push(orgPhone);
  return Array.from(new Set(out));
}

/**
 * Ask Apollo to reveal a person's phone numbers.
 *
 * Returns rather than throws: a missing key, an unreachable webhook or a
 * refusal from Apollo are all reportable outcomes, not failures that should
 * abort an enrichment run.
 */
export async function apolloRevealPhone(
  req: PhoneRevealRequest,
  webhookUrl: string | null | undefined
): Promise<PhoneRevealOutcome> {
  const apiKey = await readSecret('apollo_api_key');
  if (!apiKey) return { ok: false, phones: [], pending: false, message: 'No Apollo API key configured.' };

  if (!isDeliverableWebhook(webhookUrl)) {
    return {
      ok: false,
      phones: [],
      pending: false,
      message:
        'Phone reveal needs a public HTTPS webhook Apollo can deliver to. Set one on the enrichment policy once the app is deployed — Apollo cannot reach localhost.',
    };
  }

  const body: Record<string, unknown> = {
    reveal_phone_number: true,
    webhook_url: `${webhookUrl}${webhookUrl!.includes('?') ? '&' : '?'}record=${encodeURIComponent(req.recordId)}`,
  };
  if (req.email) body.email = req.email;
  if (req.linkedinUrl) body.linkedin_url = req.linkedinUrl;
  if (req.name) body.name = req.name;
  if (req.firstName) body.first_name = req.firstName;
  if (req.lastName) body.last_name = req.lastName;
  if (req.domain) body.domain = req.domain;
  if (req.organizationName) body.organization_name = req.organizationName;

  // Apollo needs something to match on; without it the credit buys nothing.
  if (!body.email && !body.linkedin_url && !(body.name || body.last_name)) {
    return { ok: false, phones: [], pending: false, message: 'Not enough identity to match this person.' };
  }

  try {
    const res = await fetch(`${BASE}/people/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
      return { ok: false, phones: [], pending: false, message: `Apollo ${res.status}: ${detail}` };
    }

    const data = (await res.json()) as { person?: Record<string, unknown> };
    const phones = collectPhones(data.person);
    return {
      ok: true,
      phones,
      pending: phones.length === 0,
      message: phones.length
        ? `${phones.length} number${phones.length === 1 ? '' : 's'} returned inline.`
        : 'Accepted — Apollo will deliver verified numbers to the webhook, usually within a few minutes.',
    };
  } catch (err) {
    return { ok: false, phones: [], pending: false, message: err instanceof Error ? err.message : String(err) };
  }
}
