/**
 * What an enrichment run costs.
 *
 * Enrichment is the only part of this platform that spends money per record,
 * and the spend is spread across three providers with three different units —
 * Anthropic bills tokens, Apollo bills credits, GLEIF bills nothing. Nobody
 * can hold that in their head while deciding whether to raise a daily cap, so
 * this turns a set of policy switches into one number.
 *
 * Pure and deterministic: prices and volumes in, a breakdown out. Every unit
 * price is an input rather than a constant, because provider pricing changes
 * and a hardcoded rate silently becomes a lie.
 */

export interface CostRates {
  /** USD per Apollo credit, from your plan's price ÷ credits included. */
  apolloCreditUsd: number;
  /** Credits consumed matching a person (demographics + work email). */
  apolloMatchCredits: number;
  /** Credits consumed when a mobile is returned. Apollo documents 8. */
  apolloPhoneCredits: number;
  /** Credits for a company/people search. Zero on most plans. */
  apolloSearchCredits: number;

  /** USD per million input tokens. */
  claudeInputUsdPerMTok: number;
  /** USD per million output tokens. */
  claudeOutputUsdPerMTok: number;
  /** Typical input tokens for one account-resolution call. */
  claudeInputTokens: number;
  /** Typical output tokens for one account-resolution call. */
  claudeOutputTokens: number;
  /** USD per web search Anthropic performs during a call. */
  claudeSearchUsd: number;
  /** Searches a typical resolution makes. */
  claudeSearchesPerRecord: number;

  /** Multiplier for the call-prep pass relative to resolution. */
  callPrepFactor: number;
}

export interface CostInputs {
  /** Records to enrich. */
  records: number;
  claudeEnabled: boolean;
  callPrepEnabled: boolean;
  apolloEnabled: boolean;
  /** Contacts requested per account — Apollo charges per person matched. */
  contactsPerAccount: number;
  revealPhones: boolean;
  /** Cap on reveals per run, from the policy. */
  maxPhoneReveals: number;
  /**
   * Share of records where a reveal actually returns a number. Apollo bills
   * only when credit-consuming data is found, so a low hit rate costs less —
   * assuming everything hits overstates the bill.
   */
  phoneHitRate: number;
}

export interface CostLine {
  label: string;
  detail: string;
  usd: number;
  /** Apollo credits, where the line is credit-denominated. */
  credits?: number;
}

export interface CostBreakdown {
  lines: CostLine[];
  totalUsd: number;
  totalCredits: number;
  perRecordUsd: number;
  records: number;
}

export const DEFAULT_RATES: CostRates = {
  // Apollo publishes credits, not dollars — this is a plan-dependent estimate
  // and is meant to be edited.
  apolloCreditUsd: 0.02,
  apolloMatchCredits: 1,
  apolloPhoneCredits: 8,
  apolloSearchCredits: 0,

  claudeInputUsdPerMTok: 15,
  claudeOutputUsdPerMTok: 75,
  claudeInputTokens: 3000,
  claudeOutputTokens: 4000,
  claudeSearchUsd: 0.01,
  claudeSearchesPerRecord: 4,

  callPrepFactor: 0.5,
};

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** One record's Anthropic cost for a single resolution pass. */
function claudeCallUsd(r: CostRates): number {
  return (
    (r.claudeInputTokens / 1_000_000) * r.claudeInputUsdPerMTok +
    (r.claudeOutputTokens / 1_000_000) * r.claudeOutputUsdPerMTok +
    r.claudeSearchesPerRecord * r.claudeSearchUsd
  );
}

export function calculateCost(input: CostInputs, rates: CostRates = DEFAULT_RATES): CostBreakdown {
  const records = Math.max(0, Math.floor(input.records));
  const lines: CostLine[] = [];
  let totalCredits = 0;

  if (input.claudeEnabled && records > 0) {
    const per = claudeCallUsd(rates);
    lines.push({
      label: 'Claude — account resolution',
      detail: `${records.toLocaleString()} records x ${(rates.claudeInputTokens / 1000).toFixed(0)}k in / ${(
        rates.claudeOutputTokens / 1000
      ).toFixed(0)}k out + ${rates.claudeSearchesPerRecord} searches`,
      usd: round(per * records),
    });

    if (input.callPrepEnabled) {
      lines.push({
        label: 'Claude — call-prep briefs',
        detail: `a second pass, ~${Math.round(rates.callPrepFactor * 100)}% the size of resolution`,
        usd: round(per * rates.callPrepFactor * records),
      });
    }
  }

  if (input.apolloEnabled && records > 0) {
    if (rates.apolloSearchCredits > 0) {
      const credits = rates.apolloSearchCredits * records;
      totalCredits += credits;
      lines.push({
        label: 'Apollo — company & people search',
        detail: `${rates.apolloSearchCredits} credit per record`,
        usd: round(credits * rates.apolloCreditUsd),
        credits,
      });
    }

    const people = Math.max(0, Math.floor(input.contactsPerAccount)) * records;
    const matchCredits = rates.apolloMatchCredits * people;
    totalCredits += matchCredits;
    lines.push({
      label: 'Apollo — contact match',
      detail: `${people.toLocaleString()} people x ${rates.apolloMatchCredits} credit`,
      usd: round(matchCredits * rates.apolloCreditUsd),
      credits: matchCredits,
    });

    if (input.revealPhones) {
      // Reveals are capped per run and billed only when a number comes back.
      const attempted = Math.min(records, Math.max(0, Math.floor(input.maxPhoneReveals)));
      const billed = Math.round(attempted * Math.min(1, Math.max(0, input.phoneHitRate)));
      const credits = rates.apolloPhoneCredits * billed;
      totalCredits += credits;
      lines.push({
        label: 'Apollo — direct dial reveal',
        detail: `${attempted.toLocaleString()} attempted, ~${billed.toLocaleString()} returned x ${
          rates.apolloPhoneCredits
        } credits`,
        usd: round(credits * rates.apolloCreditUsd),
        credits,
      });
    }
  }

  // GLEIF is stated rather than omitted: a zero line answers "what does the
  // hierarchy lookup cost me" without anyone having to go and check.
  lines.push({ label: 'GLEIF — corporate hierarchy', detail: 'keyless and free', usd: 0 });

  const totalUsd = round(lines.reduce((sum, l) => sum + l.usd, 0));
  return {
    lines,
    totalUsd,
    totalCredits,
    records,
    perRecordUsd: records > 0 ? round(totalUsd / records) : 0,
  };
}

/**
 * Cost per outcome, which is the number worth arguing about — a cheap run that
 * finds nothing is not cheap.
 */
export function costPerOutcome(breakdown: CostBreakdown, outcomes: number): number | null {
  if (outcomes <= 0) return null;
  return round(breakdown.totalUsd / outcomes);
}
