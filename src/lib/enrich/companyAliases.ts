import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { readSecret } from '@/lib/crypto/store';

/**
 * Other names a company is known by, for when Apollo's index does not hold the
 * one our source published.
 *
 * The third and last tier of account resolution. Tiers one and two are string
 * rules — the name as given, then with the legal suffix removed — and they fail
 * on the case that matters most here: sources name the asset-owning entity, and
 * Apollo indexes the operating business. No amount of substring trimming gets
 * from "Cleveland-Cliffs Minorca Mine Inc" to "Cleveland-Cliffs", and trimming
 * harder actively misfires: "United States Steel" shortens to "United States",
 * which matches war.gov.
 *
 * That is a knowledge problem, not a string problem, which is what Claude is
 * for.
 *
 * CLAUDE PROPOSES, APOLLO DISPOSES. Everything returned here is a search TERM,
 * checked against Apollo's index before it is believed. A model asked for a
 * domain will happily produce a plausible one that does not exist, and an
 * invented domain would send a seller's email into a void — so a domain is only
 * ever used to look the company up, never taken as the answer.
 */

const MODEL = process.env.ENRICH_MODEL || 'claude-opus-4-8';

export interface CompanyAliases {
  /** Alternative names, most likely first. Empty when nothing is known. */
  names: string[];
  /** A domain to LOOK UP, never to trust. */
  domainHint: string | null;
  /** Why, in one line — carried into the run notes so a bad alias is traceable. */
  reasoning: string | null;
}

const EMPTY: CompanyAliases = { names: [], domainHint: null, reasoning: null };

export async function isAliasHelperConfigured(): Promise<boolean> {
  return Boolean(await readSecret('anthropic_api_key'));
}

/**
 * Ask for the names this company trades under.
 *
 * Deliberately small: no web search, low token ceiling, one turn. It runs only
 * after the cheap tiers have failed, and it runs per unresolved account, so it
 * has to stay cheap enough that failing to resolve is not itself expensive.
 */
export async function suggestCompanyAliases(
  companyName: string,
  context?: { location?: string | null; vertical?: string | null }
): Promise<CompanyAliases> {
  const apiKey = await readSecret('anthropic_api_key');
  if (!apiKey || !companyName.trim()) return EMPTY;

  const where = context?.location?.trim();
  const what = context?.vertical?.trim();

  const prompt = [
    `A B2B contact database (Apollo.io) has no company matching "${companyName}".`,
    where ? `It is located in or near ${where}.` : null,
    what ? `It operates in ${what.replace(/_/g, ' ')}.` : null,
    '',
    'Apollo indexes companies under the name they trade as — usually the operating',
    'business or corporate parent, not a project vehicle, joint venture, mine name or',
    'asset-holding subsidiary.',
    '',
    'Give the names this organisation is most likely listed under, best first. Include',
    'the parent or operating company when the name given looks like a subsidiary, an',
    'asset, or a special-purpose vehicle. Include a common abbreviation only if it is',
    'genuinely how the company is known.',
    '',
    'Rules:',
    '- Return at most 3 names.',
    '- If you do not recognise the organisation, return an empty list. A guess costs',
    '  more than an empty answer: it attaches a seller to the wrong company.',
    '- Do not invent a parent that you are not confident exists.',
    '',
    'Reply with JSON only:',
    '{"names":["..."],"domain":"example.com or null","reasoning":"one short line"}',
  ]
    .filter((l) => l !== null)
    .join('\n');

  try {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return EMPTY;

    const parsed = JSON.parse(json) as { names?: unknown; domain?: unknown; reasoning?: unknown };
    const names = Array.isArray(parsed.names)
      ? parsed.names
          .filter((n): n is string => typeof n === 'string' && n.trim().length > 1)
          .map((n) => n.trim())
          // A model asked for alternatives sometimes returns the input; trying it
          // again would just repeat tier one at the cost of a call.
          .filter((n) => n.toLowerCase() !== companyName.trim().toLowerCase())
          .slice(0, 3)
      : [];

    const rawDomain = typeof parsed.domain === 'string' ? parsed.domain.trim().toLowerCase() : '';
    const domainHint =
      rawDomain && rawDomain !== 'null' && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(rawDomain.replace(/^https?:\/\//, ''))
        ? rawDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
        : null;

    return {
      names,
      domainHint,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 200) : null,
    };
  } catch (err) {
    // Never fatal. Resolution already failed without this; a broken helper
    // should leave that unchanged rather than fail the whole enrichment.
    console.error(`Company alias lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return EMPTY;
  }
}
