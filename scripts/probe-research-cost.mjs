/**
 * Where the 150 seconds actually goes, measured rather than assumed.
 *
 *   node --env-file=.env.local --experimental-transform-types \
 *        --import ./scripts/lib/register-alias.mjs scripts/probe-research-cost.mjs
 *
 * The brief job times out and I have been guessing why. Four configurations of
 * the same question, timed, so the fix is chosen from evidence:
 *
 *   A  what ships today — 16k tokens, adaptive thinking, 6 web searches
 *   B  the same, streamed
 *   C  streamed, right-sized: 4k tokens, 3 searches
 *   D  no web search at all, small prompt — the shape a per-record brief would
 *      have if account research were already cached
 *
 * D is the one that matters most. If it is fast, the answer is not "make the big
 * call fit" but "stop making the big call per record".
 */

import Anthropic from '@anthropic-ai/sdk';
import { readSecret } from '@/lib/crypto/store';

const apiKey = await readSecret('anthropic_api_key');
if (!apiKey) {
  console.error('No Anthropic key configured.');
  process.exit(1);
}
const MODEL = process.env.ENRICH_MODEL || 'claude-opus-4-8';
const client = new Anthropic({ apiKey, timeout: 280_000, maxRetries: 0 });

const COMPANY = 'Cleveland-Cliffs';
const PROJECT = 'Hibbing Taconite Mine, Minnesota';

const RESEARCH_PROMPT = `Research ${COMPANY} for a construction-technology sales team.
Find recent news, its parent and subsidiaries, other active construction projects it owns,
estimated portfolio value, revenue band, expansion signals and any construction tech it uses.
End with a fenced json block containing keys: news, parent_account, related_entities,
related_projects, portfolio_value_estimate, revenue_band, expansion_signal, tech_stack.`;

const BRIEF_PROMPT = `You are briefing a sales rep selling Evercam (AI site cameras + construction intelligence).

PROJECT: ${PROJECT}
COMPANY: ${COMPANY} — iron ore mining and steel, ~25,000 employees, Cleveland Ohio.
KNOWN CONTEXT: operates several taconite mines in Minnesota and Michigan; capital projects ongoing.

Using ONLY the context above — do not search — score ICP fit 0-100 with a one-line reason;
judge timing (reach_now / watch / too_early / too_late); name the trigger event; write a
one-line opening hook referencing this project; pick the value angle (confidence / evidence /
capacity); state the pain point Evercam solves.

Reply with a single fenced json block: {"icp_fit_score":n,"icp_fit_reason":s,"evercam_timing":s,
"trigger_event":s,"opening_hook":s,"value_angle":s,"pain_point":s}`;

const SEARCH_TOOL = (uses) => [{ type: 'web_search_20260209', name: 'web_search', max_uses: uses }];

async function timeIt(label, fn) {
  const t = Date.now();
  try {
    const r = await fn();
    const secs = ((Date.now() - t) / 1000).toFixed(1);
    console.log(`  ${label.padEnd(46)} ${String(secs).padStart(6)}s  ${r}`);
  } catch (err) {
    const secs = ((Date.now() - t) / 1000).toFixed(1);
    console.log(`  ${label.padEnd(46)} ${String(secs).padStart(6)}s  FAILED: ${err instanceof Error ? err.message : err}`);
  }
}

function summarise(res) {
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const searches = res.content.filter((b) => b.type === 'server_tool_use').length;
  return `stop=${res.stop_reason} out=${res.usage?.output_tokens ?? '?'} searches=${searches} chars=${text.length}`;
}

console.log('\nA/B/C — account research, the call that times out');

await timeIt('A  16k, adaptive thinking, 6 searches, no stream', async () => {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    tools: SEARCH_TOOL(6),
    messages: [{ role: 'user', content: RESEARCH_PROMPT }],
  });
  return summarise(res);
});

await timeIt('B  the same, streamed', async () => {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    tools: SEARCH_TOOL(6),
    messages: [{ role: 'user', content: RESEARCH_PROMPT }],
  });
  return summarise(await stream.finalMessage());
});

await timeIt('C  streamed, 4k tokens, 3 searches', async () => {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 4000,
    tools: SEARCH_TOOL(3),
    messages: [{ role: 'user', content: RESEARCH_PROMPT }],
  });
  return summarise(await stream.finalMessage());
});

console.log('\nD — the per-record brief, if account research were already cached');

await timeIt('D  no search, 1.5k tokens, small prompt', async () => {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: BRIEF_PROMPT }],
  });
  return summarise(res);
});
