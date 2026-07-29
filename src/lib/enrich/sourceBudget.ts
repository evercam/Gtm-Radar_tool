import 'server-only';
import { getAllSourceConfigs } from '@/lib/sources/config';
import { SOURCE_SLUGS } from '@/lib/sourceSlugs';
import type { EnrichmentPolicy } from '@/lib/enrich/policy';

/**
 * What enrichment may spend on a record, given where the record came from.
 *
 * The enrichment policy is global — one set of engine toggles for the whole
 * database. Sources are not alike, though. GEM records are energy asset owners
 * that Apollo's B2B index barely knows, so Apollo calls against them mostly
 * return nothing while Claude's web search does the work; news records rarely
 * have an account worth resolving at all. A single global setting has to be
 * tuned for the worst case, which over-spends on some feeds and under-serves
 * others.
 *
 * So each source may override the engines and cap how many calls one record is
 * worth. Overrides are null by default, meaning "use the policy" — a source
 * nobody has configured behaves exactly as it did before this existed.
 */

export interface SourceBudget {
  claude: boolean;
  apollo: boolean;
  fillCommittee: boolean;
  /** Hard ceiling per record, or null for whatever the policy allows. */
  maxApolloCalls: number | null;
  maxClaudeCalls: number | null;
  /** True when this source carries at least one override. */
  overridden: boolean;
}

/** source_key → slug, since records carry the key and configs are keyed by slug. */
const SLUG_BY_SOURCE_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(SOURCE_SLUGS).map(([slug, info]) => [info.sourceKey, slug])
);

export function slugForSourceKey(sourceKey: string | null | undefined): string | null {
  if (!sourceKey) return null;
  return SLUG_BY_SOURCE_KEY[sourceKey] ?? null;
}

/**
 * Resolve every source's budget in one read.
 *
 * A batch enriches records from many sources, so the configs are loaded once
 * and looked up per record rather than re-read for each one.
 */
export async function loadSourceBudgets(policy: EnrichmentPolicy): Promise<Map<string, SourceBudget>> {
  const fallback: SourceBudget = {
    claude: policy.engines.claude,
    apollo: policy.engines.apollo,
    fillCommittee: policy.fillCommittee,
    maxApolloCalls: null,
    maxClaudeCalls: null,
    overridden: false,
  };

  const budgets = new Map<string, SourceBudget>();
  try {
    const { configs, tableMissing } = await getAllSourceConfigs();
    if (tableMissing) return budgets;

    for (const [slug, c] of Object.entries(configs)) {
      const key = SOURCE_SLUGS[slug]?.sourceKey;
      if (!key) continue;
      const overridden =
        c.enrichClaude !== null ||
        c.enrichApollo !== null ||
        c.enrichFillCommittee !== null ||
        c.maxApolloCallsPerRecord !== null ||
        c.maxClaudeCallsPerRecord !== null;

      budgets.set(key, {
        // An override can only ever be more restrictive in practice, but it is
        // applied as written: a source may legitimately want Claude on while
        // the global default has it off.
        claude: c.enrichClaude ?? fallback.claude,
        apollo: c.enrichApollo ?? fallback.apollo,
        fillCommittee: c.enrichFillCommittee ?? fallback.fillCommittee,
        maxApolloCalls: c.maxApolloCallsPerRecord,
        maxClaudeCalls: c.maxClaudeCallsPerRecord,
        overridden,
      });
    }
  } catch {
    // A missing table or an unreadable config must not stop enrichment — it
    // just means nobody has overridden anything.
  }
  return budgets;
}

/** The budget for one record, falling back to the global policy. */
export function budgetFor(
  budgets: Map<string, SourceBudget>,
  sourceKey: string | null | undefined,
  policy: EnrichmentPolicy
): SourceBudget {
  const found = sourceKey ? budgets.get(sourceKey) : undefined;
  return (
    found ?? {
      claude: policy.engines.claude,
      apollo: policy.engines.apollo,
      fillCommittee: policy.fillCommittee,
      maxApolloCalls: null,
      maxClaudeCalls: null,
      overridden: false,
    }
  );
}
