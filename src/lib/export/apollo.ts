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
/** Labels live under /api/v1, not /v1. */
const BASE_ROOT = 'https://api.apollo.io';
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
  /** Contacts whose owner and list were applied after creation. */
  enriched?: number;
  /** Contacts that exist but could not be owned or filed. */
  enrichFailed?: number;
}

interface ApolloContact {
  id?: string;
  email?: string | null;
  name?: string | null;
}

/**
 * Apollo's ceiling on the NATIVE contact title, established by bisection: 100
 * characters store fine, 101 stores null. It is not documented and not reported
 * in any metadata, unlike the custom fields' `text_field_max_length`.
 */
export const NATIVE_TITLE_MAX = 100;

/** Shortens to fit, marking that it was shortened. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Splits a name into the two fields Apollo wants. */
function splitName(contact: ExportContact): { first: string | null; last: string | null } {
  if (contact.firstName || contact.lastName) return { first: contact.firstName, last: contact.lastName };
  const parts = (contact.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/**
 * The create payload.
 *
 * `owner_id`, `label_names` and `direct_phone` are deliberately NOT here. All
 * three are accepted by `bulk_create` and all three are ignored: contacts came
 * back owned by the API key's user rather than the BDR, `label_ids` came back
 * empty, the per-BDR list was never created, and the phone never appeared. They
 * are applied afterwards by `applyContactDetail`, a separate call that does take
 * effect.
 */
export function toApolloPayload(c: ExportContact): Record<string, unknown> {
  const { first, last } = splitName(c);
  return {
    first_name: first,
    last_name: last,
    email: c.email,
    // Apollo's native title caps at 100 characters and DROPS the value entirely
    // past it rather than clipping — a 206-character title arrived as null, so
    // the contact had no title at all. Clipping here trades a shortened title
    // for no title. The untruncated version still travels in the custom Job
    // Title field and in the record brief.
    title: c.title ? clip(c.title, NATIVE_TITLE_MAX) : c.title,
    organization_name: c.organizationName,
    website_url: c.website,
    ...(c.linkedinUrl ? { linkedin_url: c.linkedinUrl } : {}),
    // An explicit account id beats the name-and-website guess Apollo would
    // otherwise make.
    ...(c.accountId ? { account_id: c.accountId } : {}),
    ...(c.customFields && Object.keys(c.customFields).length ? { typed_custom_fields: c.customFields } : {}),
  };
}

/** Apollo list ids by name, resolved once per process. */
const labelIds = new Map<string, string | null>();

/**
 * The id of a contact list, created if this workspace does not have it yet.
 *
 * `label_names` on create does nothing, so the list has to exist and be attached
 * by id. Creating one requires an explicit `modality` — without it Apollo answers
 * "Please enter a non-empty modality!".
 */
export async function ensureLabelId(name: string, apiKey: string): Promise<string | null> {
  const key = name.trim();
  if (!key) return null;
  if (labelIds.has(key)) return labelIds.get(key) ?? null;

  try {
    const res = await fetch(`${BASE_ROOT}/api/v1/labels`, {
      headers: { Accept: 'application/json', 'x-api-key': apiKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const raw = (await res.json()) as { labels?: { id: string; name: string }[] } | { id: string; name: string }[];
      const list = Array.isArray(raw) ? raw : (raw.labels ?? []);
      const hit = list.find((l) => (l.name ?? '').trim() === key);
      if (hit?.id) {
        labelIds.set(key, hit.id);
        return hit.id;
      }
    }

    const made = await fetch(`${BASE_ROOT}/api/v1/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ name: key, modality: 'contacts' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!made.ok) {
      labelIds.set(key, null);
      return null;
    }
    const j = (await made.json()) as { label?: { id?: string }; id?: string };
    const id = j.label?.id ?? j.id ?? null;
    labelIds.set(key, id);
    return id;
  } catch {
    labelIds.set(key, null);
    return null;
  }
}

/**
 * Puts the owner, the list and the phone on a contact that already exists.
 *
 * A second call per contact is the cost of any of these landing at all. All three
 * are silently discarded by `bulk_create` and all three work here.
 *
 * The phone is the least obvious of them. `direct_phone` is write-only: Apollo
 * accepts it and files the number into the `phone_numbers[]` array, and reading
 * `direct_phone` back always returns null — which is why this looked for a long
 * time like the phone was not being stored at all. It was not being stored,
 * because `bulk_create` ignores the field; but the place to verify it is
 * `phone_numbers`, not `direct_phone`.
 *
 * `direct_phone` rather than `phone_numbers: [...]` deliberately: assigning the
 * array REPLACES it, which would delete the organisation number Apollo enriched
 * on its own. Appending keeps both.
 *
 * Best-effort by design: the contact is already in Apollo, so a failure here
 * means an unowned, unfiled or phoneless contact, not a lost one — and the count
 * comes back so the caller can say so rather than imply success.
 */
/**
 * What the follow-up write carries. Separated from the call so the decision of
 * which field belongs in which request is testable without a network or a key —
 * that split is the whole fix, and it is not visible from either call alone.
 */
export function buildDetailPatch(contact: ExportContact, labelId: string | null): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (contact.ownerId) patch.owner_id = contact.ownerId;
  if (contact.phone) patch.direct_phone = contact.phone;
  if (labelId) patch.label_ids = [labelId];
  /*
    The custom fields ride along too, because `bulk_create` will not update them.

    A contact Apollo already has comes back as `existing` with every custom field
    untouched, so a corrected call script, a re-rendered brief, or a fixed title
    could never reach a contact that had been sent once — the export reported
    success and changed nothing. Re-sending one now refreshes it.

    Lengths are already policed by `mapCustomFields` against Apollo's live
    text_field_max_length, and PUT enforces the same ceiling, so nothing here can
    exceed it.
  */
  if (contact.customFields && Object.keys(contact.customFields).length) {
    patch.typed_custom_fields = contact.customFields;
  }
  return patch;
}

async function applyContactDetail(
  contact: ExportContact,
  apolloContactId: string,
  apiKey: string
): Promise<{ ok: boolean; error?: string }> {
  const labelId = contact.label ? await ensureLabelId(contact.label, apiKey) : null;
  const patch = buildDetailPatch(contact, labelId);
  if (Object.keys(patch).length === 0) return { ok: true };

  try {
    const res = await fetch(`${BASE}/contacts/${apolloContactId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, error: `owner/list HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
    const results = matchResults(contacts, json.created_contacts ?? [], json.existing_contacts ?? []);

    // The owner and the list, applied now that each contact has an id. Sequential
    // on purpose: this is already one extra call per contact and hammering Apollo
    // with 100 parallel writes is how a working export starts collecting 429s.
    let enriched = 0;
    let enrichFailed = 0;
    for (const [i, r] of results.entries()) {
      if (r.outcome === 'failed' || !r.apolloContactId) continue;
      const applied = await applyContactDetail(contacts[i], r.apolloContactId, apiKey);
      if (applied.ok) enriched += 1;
      else {
        enrichFailed += 1;
        // Not a failed export — the contact is in Apollo, just unowned or unfiled.
        r.error = applied.error;
      }
    }

    return { ok: true, results, enriched, enrichFailed };
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

/** Sends a batch, retrying transient failures with exponential backoff. */
async function attemptBatch(
  contacts: ExportContact[],
  options: { dedupe?: boolean; maxAttempts?: number; sleep?: (ms: number) => Promise<void> }
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

/**
 * Sends a batch, and isolates the contact that poisoned it.
 *
 * `bulk_create` is all-or-nothing: one contact Apollo will not accept returns 422
 * and creates NOTHING, so a single bad record used to fail up to 99 good ones and
 * mark them all failed — every run, against the same offender, forever. The 422
 * body is `{"error":"Failed to create contacts"}` with no indication of which
 * contact or which field, so the only way to find out is to split and re-send.
 *
 * Halving rather than sending one at a time keeps the cost near log₂(n) calls for
 * a single offender instead of n. Splitting is safe precisely because a failed
 * batch created nothing, so no contact is sent twice.
 *
 * A rate limit or a 5xx is NOT isolated — those are about the request, not the
 * data, and bisecting them would multiply the load that caused them.
 */
export async function exportBatchWithRetry(
  contacts: ExportContact[],
  options: { dedupe?: boolean; maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<BatchOutcome> {
  const outcome = await attemptBatch(contacts, options);

  // Only split when Apollo actually judged the contacts. A rejected key or an
  // over-limit batch comes back with no per-contact results, and halving that
  // just asks the same doomed question twice as often.
  const judgedEachContact = outcome.results.length === contacts.length;
  const worthSplitting = !outcome.ok && !outcome.retryable && contacts.length > 1 && judgedEachContact;
  if (!worthSplitting) return outcome;

  const mid = Math.ceil(contacts.length / 2);
  const [left, right] = [contacts.slice(0, mid), contacts.slice(mid)];
  const [a, b] = [await exportBatchWithRetry(left, options), await exportBatchWithRetry(right, options)];

  const merged: BatchOutcome = {
    // Any contact that got through makes this a partial success, not a failure.
    ok: a.ok || b.ok,
    results: [...a.results, ...b.results],
    enriched: (a.enriched ?? 0) + (b.enriched ?? 0),
    enrichFailed: (a.enrichFailed ?? 0) + (b.enrichFailed ?? 0),
    // Never retryable: the halves have already exhausted their own retries.
    retryable: false,
  };
  const rejected = merged.results.filter((r) => r.outcome === 'failed').length;
  if (rejected) {
    merged.message =
      `Apollo rejected ${rejected} of ${contacts.length} contact${contacts.length === 1 ? '' : 's'}; ` +
      `the rest were sent. ${outcome.message ?? ''}`.trim();
  }
  return merged;
}

/** Splits a list into Apollo-sized batches. */
export function chunk<T>(items: T[], size = APOLLO_BATCH_LIMIT): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
