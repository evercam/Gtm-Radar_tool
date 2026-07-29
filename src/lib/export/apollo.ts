import 'server-only';
import { readSecret } from '@/lib/crypto/store';

/**
 * Pushing finished leads into Apollo.
 *
 * Apollo's `contacts/bulk_create` accepts at most 100 per call and reports
 * created and already-existing contacts separately — "existing" is a normal
 * outcome, not a failure, and is recorded as such so it doesn't look like an
 * error rate.
 *
 * The call is not idempotent from our side: sending the same contact twice
 * adds noise to the destination list. The caller stamps `apollo_exported_at`
 * on success and filters on it, which is what prevents a double send.
 */

const BASE = 'https://api.apollo.io/v1';
/** Apollo's documented ceiling for bulk_create. */
export const APOLLO_BATCH_LIMIT = 100;

export interface ExportContact {
  /** Our record id, echoed back so results can be matched to leads. */
  leadId: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  organizationName: string | null;
  website: string | null;
  /** Apollo list/label to file the contact under. */
  label?: string | null;
  /** Public profile — on the LDR checklist, and how a rep confirms the role. */
  linkedinUrl?: string | null;
  /**
   * The Apollo account, resolved by id. Never a domain: five accounts in this
   * workspace share balfourbeatty.com and the country field does not tell them
   * apart, so a domain match files contacts against the wrong CRM record.
   */
  accountId?: string | null;
  /** Apollo user id of the BDR who owns this contact. */
  ownerId?: string | null;
  /** Sequence to enrol into. */
  sequenceId?: string | null;
  /** typed_custom_fields payload, already keyed by Apollo field id. */
  customFields?: Record<string, string>;
}

export type ExportOutcome = 'created' | 'existing' | 'failed';

export interface ExportResult {
  leadId: string;
  outcome: ExportOutcome;
  apolloContactId: string | null;
  error?: string;
}

export interface BatchOutcome {
  ok: boolean;
  results: ExportResult[];
  message?: string;
  /** True when the failure is worth retrying (rate limit or a 5xx). */
  retryable?: boolean;
}

interface ApolloContact {
  id?: string;
  email?: string | null;
  name?: string | null;
}

/** Splits a name into the two fields Apollo wants. */
function splitName(contact: ExportContact): { first: string | null; last: string | null } {
  if (contact.firstName || contact.lastName) return { first: contact.firstName, last: contact.lastName };
  const parts = (contact.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function toApolloPayload(c: ExportContact): Record<string, unknown> {
  const { first, last } = splitName(c);
  return {
    first_name: first,
    last_name: last,
    email: c.email,
    title: c.title,
    organization_name: c.organizationName,
    website_url: c.website,
    ...(c.phone ? { direct_phone: c.phone } : {}),
    ...(c.linkedinUrl ? { linkedin_url: c.linkedinUrl } : {}),
    // An explicit account id beats the name-and-website guess Apollo would
    // otherwise make.
    ...(c.accountId ? { account_id: c.accountId } : {}),
    ...(c.ownerId ? { owner_id: c.ownerId } : {}),
    ...(c.label ? { label_names: [c.label] } : {}),
    ...(c.customFields && Object.keys(c.customFields).length ? { typed_custom_fields: c.customFields } : {}),
  };
}

/** Matches Apollo's response back to our leads, by email then by name. */
function matchResults(contacts: ExportContact[], created: ApolloContact[], existing: ApolloContact[]): ExportResult[] {
  const byEmail = new Map<string, { outcome: ExportOutcome; id: string | null }>();
  const byName = new Map<string, { outcome: ExportOutcome; id: string | null }>();

  const index = (list: ApolloContact[], outcome: ExportOutcome) => {
    for (const c of list) {
      if (c.email) byEmail.set(c.email.toLowerCase(), { outcome, id: c.id ?? null });
      if (c.name) byName.set(c.name.toLowerCase(), { outcome, id: c.id ?? null });
    }
  };
  index(created, 'created');
  index(existing, 'existing');

  return contacts.map((c) => {
    const hit =
      (c.email ? byEmail.get(c.email.toLowerCase()) : undefined) ??
      (c.name ? byName.get(c.name.toLowerCase()) : undefined);

    // Apollo silently drops contacts it won't accept, so anything absent from
    // both lists is a failure rather than an assumed success.
    if (!hit)
      return { leadId: c.leadId, outcome: 'failed' as const, apolloContactId: null, error: 'Not returned by Apollo' };
    return { leadId: c.leadId, outcome: hit.outcome, apolloContactId: hit.id };
  });
}

/** Sends one batch (≤100). Never throws — failures come back in the result. */
export async function exportBatch(
  contacts: ExportContact[],
  options: { dedupe?: boolean } = {}
): Promise<BatchOutcome> {
  if (contacts.length === 0) return { ok: true, results: [] };
  if (contacts.length > APOLLO_BATCH_LIMIT) {
    return { ok: false, results: [], message: `A batch may contain at most ${APOLLO_BATCH_LIMIT} contacts.` };
  }

  const apiKey = await readSecret('apollo_api_key');
  if (!apiKey) return { ok: false, results: [], message: 'No Apollo API key configured.' };

  try {
    const res = await fetch(`${BASE}/contacts/bulk_create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        contacts: contacts.map(toApolloPayload),
        run_dedupe: options.dedupe !== false,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      // 429 and 5xx are transient; 401/422 mean the request itself is wrong
      // and retrying would just burn quota.
      const retryable = res.status === 429 || res.status >= 500;
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        retryable,
        results: contacts.map((c) => ({
          leadId: c.leadId,
          outcome: 'failed' as const,
          apolloContactId: null,
          error: `HTTP ${res.status}`,
        })),
        message:
          res.status === 401
            ? 'Apollo rejected the API key.'
            : res.status === 422
              ? `Apollo rejected the payload: ${body.slice(0, 200)}`
              : res.status === 429
                ? 'Apollo rate limit reached.'
                : `Apollo returned ${res.status}.`,
      };
    }

    const json = (await res.json()) as { created_contacts?: ApolloContact[]; existing_contacts?: ApolloContact[] };
    return {
      ok: true,
      results: matchResults(contacts, json.created_contacts ?? [], json.existing_contacts ?? []),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      // A timeout or a dropped connection is worth another go.
      retryable: true,
      results: contacts.map((c) => ({
        leadId: c.leadId,
        outcome: 'failed' as const,
        apolloContactId: null,
        error: message,
      })),
      message,
    };
  }
}

/**
 * Sends a batch, retrying transient failures with exponential backoff.
 *
 * Only retryable outcomes are re-sent — a rejected key or a malformed payload
 * fails immediately rather than being attempted three times.
 */
export async function exportBatchWithRetry(
  contacts: ExportContact[],
  options: { dedupe?: boolean; maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<BatchOutcome> {
  const maxAttempts = options.maxAttempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let last: BatchOutcome = { ok: false, results: [], message: 'Not attempted.' };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await exportBatch(contacts, options);
    if (last.ok || !last.retryable) return last;
    if (attempt < maxAttempts) await sleep(1000 * 2 ** (attempt - 1));
  }

  return last;
}

/** Splits a list into Apollo-sized batches. */
export function chunk<T>(items: T[], size = APOLLO_BATCH_LIMIT): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
