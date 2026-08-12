/**
 * Whether an email address has actually been verified — combining what Apollo
 * says with what we could check ourselves.
 *
 * Today `email_verified` means one thing: the company's domain has an MX record.
 * That is the `basic` fallback in validate.ts, taken because no Hunter key is
 * configured, and it caps confidence at 0.6. Measured on 72 exported contacts:
 * `email_validation_source` was `basic` on all of them and confidence was under
 * 0.7 on every single one, while 59 carried `email_verified: true`.
 *
 * An MX check passes for every real company whether or not the person still works
 * there, and whether or not the address was ever anything more than a guess at the
 * company's naming pattern. So it cannot detect either failure behind the reported
 * 30% stale rate, and the export's "require a validated channel" gate is checking
 * something that is true of every employed person on earth.
 *
 * There is a better signal and we already pay for it. Apollo returns `email_status`
 * on the person object — `verified` when it has confirmed the mailbox,
 * `guessed` when the address is derived from the company's pattern
 * (first.last@domain), `unavailable` when it has nothing. We were discarding it.
 *
 * A guessed address is the bounce case. It is also exactly the one an MX check
 * waves through, because the domain is real — the mailbox is what does not exist.
 *
 * Pure — no I/O — so the precedence is testable and the same rule applies wherever
 * a verdict is formed.
 */

/** What Apollo reports about an address. Unknown when the field is absent. */
export type ApolloEmailStatus = 'verified' | 'guessed' | 'unavailable' | 'unknown';

/** What our own validator managed, from lib/enrich/validate.ts. */
export interface LocalEmailCheck {
  valid: boolean;
  confidence: number;
  /** `hunter` is a real mailbox check; `basic` is an MX lookup on the domain. */
  source: 'hunter' | 'basic' | null;
  roleBased?: boolean;
  domainExists?: boolean;
}

export interface EmailVerdict {
  verified: boolean;
  confidence: number;
  /** What actually decided it, for the column and for a human reading a row. */
  source: string;
  /** One line explaining the verdict. */
  reason: string;
}

export function normaliseApolloStatus(raw: unknown): ApolloEmailStatus {
  if (typeof raw !== 'string') return 'unknown';
  const v = raw.trim().toLowerCase();
  if (v === 'verified') return 'verified';
  // Apollo has used several spellings for a pattern-derived address over time.
  if (v === 'guessed' || v === 'likely' || v === 'unverified') return 'guessed';
  if (v === 'unavailable' || v === 'not_available' || v === 'none') return 'unavailable';
  return 'unknown';
}

/**
 * The verdict, by precedence.
 *
 * Apollo's `guessed` OVERRIDES a passing local check. That is the whole point of
 * this file: a pattern-derived address on a real domain passes an MX lookup and is
 * still a guess, so treating the MX pass as verification is how a guess reaches a
 * seller labelled verified.
 *
 * A real mailbox check (Hunter) outranks Apollo either way — it tested the actual
 * address rather than reporting a provenance. It is currently never used because no
 * key is configured, and this is written so that adding one later changes the
 * outcome without changing this logic.
 */
export function emailVerdict(apolloStatus: ApolloEmailStatus, local: LocalEmailCheck | null | undefined): EmailVerdict {
  // A genuine mailbox check wins outright, in both directions.
  if (local?.source === 'hunter') {
    return {
      verified: local.valid,
      confidence: local.confidence,
      source: 'hunter',
      reason: local.valid ? 'Mailbox verified directly.' : 'Mailbox check says this address is not deliverable.',
    };
  }

  if (apolloStatus === 'guessed') {
    /*
      Not verified, and deliberately not zero confidence either. A guessed address
      on the right domain is often correct — it is how most B2B addresses are
      formed — but it has not been checked and must not be presented as if it had.
      0.35 keeps it usable while ranking it below anything confirmed.
    */
    return {
      verified: false,
      confidence: 0.35,
      source: 'apollo_guessed',
      reason: 'Apollo derived this from the company pattern rather than confirming it — expect bounces.',
    };
  }

  if (apolloStatus === 'verified') {
    /*
      Apollo confirmed the mailbox. Higher than the 0.6 an MX check can claim, but
      short of a direct check: Apollo's own confirmation can be months old, and a
      person who has since left still has a mailbox that accepts mail.
    */
    return {
      verified: true,
      confidence: local?.domainExists === false ? 0.5 : 0.8,
      source: 'apollo_verified',
      reason:
        local?.domainExists === false
          ? 'Apollo reports this verified, but the domain has no mail server — treat with caution.'
          : 'Apollo confirmed this mailbox.',
    };
  }

  if (apolloStatus === 'unavailable') {
    return { verified: false, confidence: 0, source: 'apollo_unavailable', reason: 'Apollo has no address for this person.' };
  }

  // Nothing from Apollo. Fall back to what we could check, and SAY that it was only
  // the domain — so nobody reads this as verification of the person.
  if (!local) {
    return { verified: false, confidence: 0, source: 'none', reason: 'No address check has been run.' };
  }
  return {
    verified: local.valid,
    confidence: local.confidence,
    source: local.source ?? 'none',
    reason: local.valid
      ? 'Only the domain was checked — the mailbox itself is unconfirmed.'
      : 'The domain has no mail server.',
  };
}
