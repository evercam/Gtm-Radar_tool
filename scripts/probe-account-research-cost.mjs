/**
 * How much web search can account research afford?
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/probe-account-research-cost.mjs
 *
 * The right-sized research call measured 63s once and then took 547s and died on
 * a real record. One sample was not a measurement. Search depth is the variable
 * that dominates, and this pins it — including the case of no search at all.
 *
 * The searchless option is more attractive than it first looks: the research is
 * cached for 90 days, so "recent news" is stale most of the time it is read. If
 * the model's own knowledge of a company is adequate, reliability is worth more
 * than a recency it cannot keep anyway.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readSecret } from '@/lib/crypto/store';

const apiKey = await readSecret('anthropic_api_key');
if (!apiKey) {
  console.error('No Anthropic key configured.');
  process.exit(1);
}
const MODEL = process.env.ENRICH_MODEL || 'claude-opus-4-8';
const client = new Anthropic({ apiKey, timeout: 200_000, maxRetries: 0 });

const prompt = (company) =>
  `Research ${company} for a construction-technology sales team. Establish its corporate parent; subsidiaries or JV partners that build on its behalf; other active construction projects it owns; roughly what its capital programme is worth; revenue band and headcount; any current expansion or funding signal; construction software it is known to use. Then write a 100-150 word summary a rep would read before calling anyone there. Leave a field null rather than guessing. End with exactly one fenced json block: {"summary":string,"parent_account":string|null,"related_projects":[{"name":string,"stage":string}],"portfolio_value_estimate":number|null,"revenue_band":string|null,"employee_count":number|null,"expansion_signal":string|null,"tech_stack":[string]}`;

async function go(label, company, tools) {
  const t = Date.now();
  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt(company) }],
      ...(tools ? { tools } : {}),
    });
    const res = await stream.finalMessage();
    const txt = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const searches = res.content.filter((b) => b.type === 'server_tool_use').length;
    console.log(
      `  ${label.padEnd(26)} ${((Date.now() - t) / 1000).toFixed(1).padStart(7)}s  searches=${String(searches).padStart(2)}  out=${res.usage.output_tokens}  chars=${txt.length}`
    );
    return txt;
  } catch (err) {
    console.log(`  ${label.padEnd(26)} ${((Date.now() - t) / 1000).toFixed(1).padStart(7)}s  FAILED: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

const search = (n) => [{ type: 'web_search_20260209', name: 'web_search', max_uses: n }];

console.log('\nCleveland-Cliffs — a company the model will know well');
const noSearch = await go('no search', 'Cleveland-Cliffs', null);
await go('1 search', 'Cleveland-Cliffs', search(1));
await go('2 searches', 'Cleveland-Cliffs', search(2));

console.log('\nA smaller, more obscure owner — where knowledge alone may not do');
await go('no search', 'Tacora Resources', null);
await go('1 search', 'Tacora Resources', search(1));

console.log('\n--- searchless output for Cleveland-Cliffs, to judge whether it is good enough ---\n');
console.log((noSearch ?? '(failed)').slice(0, 1400));
