import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { readSecret } from '@/lib/crypto/store';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';

/**
 * Web research about a COMPANY, done once per company.
 *
 * This is the call that broke the brief job. It was being made per RECORD, and
 * the corpus is 22,990 records across 11,592 accounts — NextEra Energy alone
 * holds 270. The research question is "what is NextEra Energy", and the answer
 * does not vary by which of its 270 solar farms prompted it, so 269 of those
 * calls were buying the same paragraph again.
 *
 * WEB SEARCH IS OFF BY DEFAULT, which is not where I expected to land. Measured:
 *
 *                        Cleveland-Cliffs   Tacora Resources
 *   no search                      14.0s              8.8s
 *   max_uses: 1                    54.4s             62.2s
 *   max_uses: 2                   315.2s                 —
 *   16k + 6 uses, unstreamed        280s  TIMED OUT
 *
 * `max_uses` is not a cap. At `max_uses: 1` the model performed SEVEN searches;
 * at 2, twelve. So search depth cannot be budgeted, and a step that must finish
 * inside a serverless function cannot depend on it — that is what killed the
 * first version, which took 547s on a real record and was terminated.
 *
 * Dropping search costs recency and buys reliability, and the trade is better
 * than it sounds because the result is CACHED FOR 90 DAYS: "recent news" is
 * stale for most of the time anyone reads it. What the model knows unaided is
 * adequate for exactly the accounts that matter — the large portfolio owners
 * hold most of the records — and it declines to invent, which is the property
 * worth protecting. Asked about Cleveland-Cliffs it gave the revenue band,
 * headcount and the Middletown Works decarbonisation programme, and left the
 * construction software null rather than guessing at Procore.
 *
 * Set ACCOUNT_RESEARCH_SEARCH=1 to turn search back on for a manual, one-off
 * pass where the extra minute is affordable.
 *
 * Results land in `account_enrichment`, which already had columns for every one
 * of them and was being written on every record enrichment while never being
 * read back as a cache.
 */

const MODEL = process.env.ENRICH_MODEL || 'claude-opus-4-8';

/** Days before a company is researched again. Portfolios move, slowly. */
const TTL_DAYS = Number(process.env.ACCOUNT_RESEARCH_TTL_DAYS) || 90;

export interface AccountResearch {
  summary: string | null;
  parent_account: string | null;
  related_entities: Array<{ name?: string | null; role?: string | null; relationship?: string | null }>;
  related_projects: Array<{ name?: string | null; location?: string | null; stage?: string | null; est_value?: number | null }>;
  portfolio_value_estimate: number | null;
  revenue_band: string | null;
  employee_count: number | null;
  expansion_signal: string | null;
  tech_stack: string[];
  /** Where this came from, so a caller can report a cache hit honestly. */
  cached: boolean;
}

const EMPTY: Omit<AccountResearch, 'cached'> = {
  summary: null,
  parent_account: null,
  related_entities: [],
  related_projects: [],
  portfolio_value_estimate: null,
  revenue_band: null,
  employee_count: null,
  expansion_signal: null,
  tech_stack: [],
};

/** The object out of a reply that may be fenced, prose-wrapped, or both. */
function extractObject(text: string): string {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (fenced.length) return fenced[fenced.length - 1][1].trim();
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  return open >= 0 && close > open ? text.slice(open, close + 1) : text;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Research already on file for this account, if it is fresh enough.
 *
 * Returns null both when there is none and when the columns do not exist yet —
 * the migration is optional, and without it every account simply reads as never
 * researched. Degrading costs a repeated call; failing would cost the brief.
 */
export async function readAccountResearch(accountKey: string): Promise<AccountResearch | null> {
  if (!accountKey || !isSupabaseServiceConfigured()) return null;
  try {
    const service = getServiceSupabase();
    const { data, error } = await service
      .from('account_enrichment')
      .select(
        'researched_at, research_summary, parent_account, related_entities, related_projects, portfolio_value_estimate, revenue_band, employee_count, expansion_signal, tech_stack'
      )
      .eq('account_key', accountKey)
      .maybeSingle();

    if (error) {
      // Missing columns are expected until the migration runs, and are not worth
      // shouting about on every account. Anything else is.
      if (!/researched_at|research_summary|column/i.test(error.message)) {
        console.warn(`Account research read failed for ${accountKey}: ${error.message}`);
      }
      return null;
    }
    const row = data as Record<string, unknown> | null;
    if (!row?.researched_at) return null;

    const age = Date.now() - new Date(row.researched_at as string).getTime();
    if (!Number.isFinite(age) || age > TTL_DAYS * 86_400_000) return null;

    return {
      summary: str(row.research_summary),
      parent_account: str(row.parent_account),
      related_entities: arr(row.related_entities),
      related_projects: arr(row.related_projects),
      portfolio_value_estimate: num(row.portfolio_value_estimate),
      revenue_band: str(row.revenue_band),
      employee_count: num(row.employee_count),
      expansion_signal: str(row.expansion_signal),
      tech_stack: arr<string>(row.tech_stack),
      cached: true,
    };
  } catch (err) {
    console.warn(`Account research unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** One web-search call about the company. Right-sized; see the note above. */
export async function researchAccount(
  companyName: string,
  context: { domain?: string | null; vertical?: string | null } = {}
): Promise<Omit<AccountResearch, 'cached'> | null> {
  const apiKey = await readSecret('anthropic_api_key');
  if (!apiKey || !companyName.trim()) return null;

  const prompt = [
    `Research ${companyName}${context.domain ? ` (${context.domain})` : ''} for a construction-technology sales team.`,
    context.vertical ? `It operates in ${context.vertical.replace(/_/g, ' ')}.` : null,
    '',
    'Evercam sells site cameras and progress-documentation software to owners,',
    'developers and contractors. What matters is the size and shape of this',
    "company's construction activity, not its products.",
    '',
    'From what you already know — do not speculate to fill a field — establish:',
    'its corporate parent; subsidiaries or joint-venture partners that',
    'build on its behalf; other active construction projects it owns or builds;',
    'roughly what its capital programme is worth; its revenue band and headcount;',
    'any current expansion, funding or pipeline signal; and any construction',
    'software it is known to use.',
    '',
    'Include a 100-150 word summary a sales rep would read before calling',
    'anyone at this company, as the `summary` field. Say "likely" or',
    '"reportedly" where you are inferring, and leave a field null rather than',
    'guessing — an invented parent company or project attaches a rep to the wrong',
    'business. A thin, honest answer is more useful than a full, uncertain one:',
    'the summary is read before a call and a rep will repeat what it says.',
    '',
    'Reply with a JSON object and nothing else — no preamble, no code fence:',
    '{"summary":string,"parent_account":string|null,',
    '"related_entities":[{"name":string,"role":string,"relationship":string}],',
    '"related_projects":[{"name":string,"location":string,"stage":string,"est_value":number|null}],',
    '"portfolio_value_estimate":number|null,"revenue_band":string|null,',
    '"employee_count":number|null,"expansion_signal":string|null,"tech_stack":[string]}',
  ]
    .filter((l) => l !== null)
    .join('\n');

  // Opt-in only; see the note at the top of this file. With search the call runs
  // 55-315s and sometimes not at all, which no per-invocation budget survives.
  const useSearch = process.env.ACCOUNT_RESEARCH_SEARCH === '1';

  try {
    const client = new Anthropic({
      apiKey,
      // Generous against a measured 9-14s searchless, and long enough for one
      // searched call when that is deliberately enabled.
      timeout: Number(process.env.ACCOUNT_RESEARCH_TIMEOUT_MS) || (useSearch ? 180_000 : 60_000),
      maxRetries: 1,
    });
    // Streamed either way: the SDK's own timeout heuristics are worst on a
    // request held open with nothing arriving, which is precisely this shape.
    const stream = client.messages.stream({
      model: MODEL,
      // Headroom for the prose the model writes before the object. At 2500 a
      // probe response was cut off mid-fence, ending in the literal "```jso".
      // Prefilling the assistant turn would avoid the waste and this model
      // refuses it: "does not support assistant message prefill".
      max_tokens: 4000,
      ...(useSearch ? { tools: [{ type: 'web_search_20260209' as const, name: 'web_search', max_uses: 1 }] } : {}),
      messages: [{ role: 'user', content: prompt }],
    });
    const res = await stream.finalMessage();

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (res.stop_reason === 'max_tokens') {
      console.warn(`Account research for ${companyName} was cut off at the token limit.`);
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(extractObject(text)) as Record<string, unknown>;
    } catch {
      // The prose is still worth keeping even when the block is malformed — the
      // per-record brief reads the summary, not the structured fields.
      return { ...EMPTY, summary: text.slice(0, 1500) || null };
    }

    return {
      summary: str(parsed.summary) ?? text.slice(0, 1500) ?? null,
      parent_account: str(parsed.parent_account),
      related_entities: arr(parsed.related_entities),
      related_projects: arr(parsed.related_projects),
      portfolio_value_estimate: num(parsed.portfolio_value_estimate),
      revenue_band: str(parsed.revenue_band),
      employee_count: num(parsed.employee_count),
      expansion_signal: str(parsed.expansion_signal),
      tech_stack: arr<string>(parsed.tech_stack),
    };
  } catch (err) {
    console.error(`Account research failed for ${companyName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Research on file, or freshly obtained and stored.
 *
 * The one function callers need. A company met for the second time costs
 * nothing, which is the entire point.
 */
export async function ensureAccountResearch(
  accountKey: string,
  companyName: string,
  context: { domain?: string | null; vertical?: string | null } = {}
): Promise<AccountResearch | null> {
  const cached = await readAccountResearch(accountKey);
  if (cached) return cached;

  const fresh = await researchAccount(companyName, context);
  if (!fresh) return null;

  if (accountKey && isSupabaseServiceConfigured()) {
    try {
      const service = getServiceSupabase();
      const findings = {
        account_key: accountKey,
        account_name: companyName,
        parent_account: fresh.parent_account,
        related_entities: fresh.related_entities,
        related_projects: fresh.related_projects,
        portfolio_project_count: fresh.related_projects.length,
        portfolio_value_estimate: fresh.portfolio_value_estimate,
        revenue_band: fresh.revenue_band,
        employee_count: fresh.employee_count,
        expansion_signal: fresh.expansion_signal,
        tech_stack: fresh.tech_stack,
      };

      const { error } = await service
        .from('account_enrichment')
        .upsert(
          { ...findings, research_summary: fresh.summary, researched_at: new Date().toISOString() },
          { onConflict: 'account_key' }
        );

      if (error && /research_summary|researched_at|column/i.test(error.message)) {
        // The two caching columns are a separate migration. Without them the
        // FINDINGS are still worth storing — they feed the account page and the
        // key-account rubric — so the write degrades to what the table can hold
        // rather than throwing the research away. What is lost is only the
        // ability to recognise it later, so every project of this company pays
        // for the call again.
        const { error: retry } = await service
          .from('account_enrichment')
          .upsert(findings, { onConflict: 'account_key' });
        if (retry) console.error(`Account research write failed for ${accountKey}: ${retry.message}`);
        else
          console.warn(
            `Stored research for ${accountKey} without a cache marker — run the account_research migration so it is only paid for once.`
          );
      } else if (error) {
        // Loud, because a write that silently fails means paying for this
        // company's research again on every one of its projects — 270 for NextEra.
        console.error(`Account research write failed for ${accountKey}: ${error.message}`);
      }
    } catch (err) {
      console.error(`Account research write threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ...fresh, cached: false };
}
