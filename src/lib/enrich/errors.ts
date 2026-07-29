/**
 * Turning a provider failure into something a person can act on.
 *
 * The SDKs surface the provider's raw JSON body as the error message, so a
 * spent credit balance reached the UI as:
 *
 *   400 {"type":"error","error":{"type":"invalid_request_error","message":
 *   "Your credit balance is too low to access the Anthropic API…"}}
 *
 * which reads as a bug in the app rather than a bill to pay.
 *
 * The kind matters as much as the text. Some failures are specific to one
 * record and the batch should move on; others — no credit, a bad key — will
 * repeat identically for every remaining record, so continuing burns the
 * daily cap to produce a hundred copies of the same message.
 */

export type EnrichErrorKind = 'billing' | 'auth' | 'rate_limit' | 'timeout' | 'unknown';

export interface ClassifiedError {
  kind: EnrichErrorKind;
  /** Human-readable, safe to show in the UI. */
  message: string;
  /** True when every remaining record would fail the same way. */
  fatal: boolean;
}

/** Pull the provider's own message out of an SDK error string. */
function humanize(raw: string): string {
  const match = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return raw.slice(0, 300);
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

export function classifyEnrichError(err: unknown): ClassifiedError {
  const status = (err as { status?: number })?.status;
  const raw = err instanceof Error ? err.message : String(err);
  const detail = humanize(raw);

  if (/credit balance|billing|insufficient (funds|credit)|purchase credits|payment required/i.test(detail) || status === 402) {
    return {
      kind: 'billing',
      fatal: true,
      message: `Provider credit exhausted — ${detail} Nothing was charged and the queue is unchanged.`,
    };
  }

  if (status === 401 || status === 403 || /invalid.*api[- ]?key|authentication|unauthorized|permission/i.test(detail)) {
    return {
      kind: 'auth',
      fatal: true,
      message: `Provider rejected the API key — ${detail} Check it in Settings.`,
    };
  }

  if (status === 429 || /rate limit|too many requests/i.test(detail)) {
    // Transient by definition: the next record may well succeed after backoff.
    return { kind: 'rate_limit', fatal: false, message: `Rate limited — ${detail}` };
  }

  if (/timeout|timed out|aborted|ETIMEDOUT|ECONNRESET/i.test(detail)) {
    return { kind: 'timeout', fatal: false, message: `Timed out — ${detail}` };
  }

  return { kind: 'unknown', fatal: false, message: detail };
}
