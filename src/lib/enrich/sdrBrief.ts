import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { readSecret } from '@/lib/crypto/store';
import type { EnrichInput, SdrIntel } from '@/lib/enrich/types';
import { arrivalFor } from '@/lib/arrival';
import type { AccountResearch } from '@/lib/enrich/accountResearch';

/**
 * The SDR judgement for ONE project: is it a fit, is the timing right, and what
 * do you open with.
 *
 * Deliberately searchless. Everything it needs is already known by the time it
 * runs — the project's own fields, and the company research that
 * `accountResearch` did once for the whole company. Asking the web again per
 * project is what made this unaffordable.
 *
 * Measured at 4.7s in that shape, against 280s for the call it replaces. That
 * difference is the whole fix: a per-record step has to be cheap because there
 * are 22,990 records, and a per-company step can afford to be slow because there
 * are far fewer companies than projects.
 */

const MODEL = process.env.SDR_BRIEF_MODEL || process.env.ENRICH_MODEL || 'claude-opus-4-8';

export interface SdrBriefResult {
  ok: boolean;
  sdr: SdrIntel | null;
  message?: string;
}

const TIMINGS = ['reach_now', 'watch', 'too_early', 'too_late'] as const;
const ANGLES = ['confidence', 'evidence', 'capacity'] as const;

/**
 * The JSON object out of a reply that may be wrapped in prose, fenced, or both.
 *
 * Takes the LAST fenced block rather than the first: the model sometimes shows a
 * worked example before its answer, and the first block is then the example.
 */
function extractObject(text: string): string {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (fenced.length) return fenced[fenced.length - 1][1].trim();
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  return open >= 0 && close > open ? text.slice(open, close + 1) : text;
}

function coerce(raw: unknown): SdrIntel | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const score = typeof o.icp_fit_score === 'number' && Number.isFinite(o.icp_fit_score)
    ? Math.max(0, Math.min(100, Math.round(o.icp_fit_score)))
    : null;
  const timing = TIMINGS.includes(o.evercam_timing as never) ? (o.evercam_timing as SdrIntel['evercam_timing']) : null;
  const angle = ANGLES.includes(o.value_angle as never) ? (o.value_angle as SdrIntel['value_angle']) : null;

  const sdr: SdrIntel = {
    icp_fit_score: score,
    icp_fit_reason: str(o.icp_fit_reason),
    evercam_timing: timing,
    trigger_event: str(o.trigger_event),
    opening_hook: str(o.opening_hook),
    value_angle: angle,
    pain_point: str(o.pain_point),
  };
  // A brief with nothing in it is a failure, not an empty success — the caller
  // decides whether to leave the record queued for another attempt.
  return Object.values(sdr).some((v) => v !== null) ? sdr : null;
}

export async function generateSdrBrief(
  input: EnrichInput,
  research: AccountResearch | null,
  accountName?: string | null
): Promise<SdrBriefResult> {
  const apiKey = await readSecret('anthropic_api_key');
  if (!apiKey) return { ok: false, sdr: null, message: 'No Anthropic key configured.' };
  if (!input.canonical_name?.trim()) return { ok: false, sdr: null, message: 'A record with at least a name is required.' };

  const arrival = arrivalFor(input);
  const company = accountName || input.company_name_raw || 'the company';

  const facts = [
    `PROJECT: ${input.canonical_name}`,
    `COMPANY: ${company}`,
    input.record_type ? `Record type: ${input.record_type}` : null,
    input.vertical ? `Sector: ${input.vertical.replace(/_/g, ' ')}` : null,
    [input.city, input.state_province, input.country].filter(Boolean).length
      ? `Location: ${[input.city, input.state_province, input.country].filter(Boolean).join(', ')}`
      : null,
    input.estimated_value
      ? `Value: ${input.estimated_value.toLocaleString()} ${input.estimated_value_currency ?? ''}`.trim()
      : null,
    input.description ? `Description: ${input.description.slice(0, 900)}` : null,
    // The timing, with its basis, so a verdict inferred from a phase is not
    // asserted as a measured date.
    `TIMING: ${arrival.summary}`,
    arrival.dated ? null : 'Timing note: no build dates published — the above is inferred from the project phase.',
  ].filter(Boolean);

  // `research?.summary` rather than `research` — a caller may hand over a
  // partially-shaped object, and a crash here would lose a brief over a
  // missing array.
  const companyContext = research?.summary
    ? [
        '',
        `ABOUT ${company.toUpperCase()} (researched separately, reuse it — do not contradict it):`,
        research.summary,
        research.parent_account ? `Parent: ${research.parent_account}` : null,
        research.revenue_band ? `Revenue band: ${research.revenue_band}` : null,
        research.employee_count ? `Headcount: ${research.employee_count.toLocaleString()}` : null,
        research.expansion_signal ? `Expansion signal: ${research.expansion_signal}` : null,
        research.tech_stack?.length ? `Known construction tech: ${research.tech_stack.join(', ')}` : null,
        research.related_projects?.length
          ? `Other active projects: ${research.related_projects
              .slice(0, 6)
              .map((p) => [p.name, p.stage].filter(Boolean).join(' — '))
              .join('; ')}`
          : null,
      ].filter(Boolean)
    : ['', 'No company research is on file, so judge from the project alone and keep the confidence low.'];

  const prompt = `You are qualifying one lead for a rep selling Evercam — AI construction site cameras and progress-documentation software. Buyers use it for remote site visibility, verified progress evidence in disputes, and covering many or hard-to-reach sites.

${facts.join('\n')}
${companyContext.join('\n')}

Judge THIS project. Do not search; use only what is above and widely known context about the company.

evercam_timing must follow the TIMING line above:
  reach_now  — mobilising or on site imminently; cameras go in at mobilisation
  watch      — planned and real, but too far out to install
  too_early  — early planning, no commitment yet
  too_late   — built, operating, cancelled, or nearly finished

Reply with a JSON object and nothing else — no preamble, no code fence:
{
  "icp_fit_score": 0-100,
  "icp_fit_reason": "One line. Why this company and project fit, or do not.",
  "evercam_timing": "reach_now|watch|too_early|too_late",
  "trigger_event": "The specific thing that makes now the moment, or null.",
  "opening_hook": "One sentence a rep could actually say, naming THIS project.",
  "value_angle": "confidence|evidence|capacity",
  "pain_point": "The problem Evercam removes here."
}`;

  try {
    const client = new Anthropic({
      apiKey,
      timeout: Number(process.env.SDR_BRIEF_TIMEOUT_MS) || 60_000,
      maxRetries: 1,
    });
    const res = await client.messages.create({
      model: MODEL,
      // Headroom, not economy. The object itself is ~200 tokens, but the model
      // reasons in prose first whatever the instructions say, and at 1500 that
      // preamble ate the budget and the JSON was cut off mid-key — a response
      // ending in the literal text "```jso". Prefilling the assistant turn with
      // a brace would be the tidier fix and this model rejects it outright:
      // "does not support assistant message prefill".
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    // Truncation reported as truncation. It is a "give it more room" problem, not
    // a "the model would not answer" problem, and the two need different fixes.
    if (res.stop_reason === 'max_tokens') {
      return { ok: false, sdr: null, message: 'The brief was cut off at the token limit before it finished.' };
    }

    let sdr: SdrIntel | null = null;
    try {
      sdr = coerce(JSON.parse(extractObject(text)));
    } catch {
      return { ok: false, sdr: null, message: `The brief was not valid JSON: ${text.slice(0, 120)}` };
    }
    if (!sdr) return { ok: false, sdr: null, message: 'The brief came back empty.' };
    return { ok: true, sdr };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`SDR brief failed for ${input.canonical_name}: ${message}`);
    return { ok: false, sdr: null, message };
  }
}
