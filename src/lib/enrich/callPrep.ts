import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { readSecret } from '@/lib/crypto/store';
import { getEnrichmentProfile } from '@/lib/enrich/profiles';
import type { EnrichInput } from '@/lib/enrich/types';

/**
 * Call preparation.
 *
 * Once a record reaches ENRICHED it has an account and a validated contact,
 * but a seller still has to work out what to say. This generates the brief
 * they read before dialling: what the company is, who they're calling, why
 * now, and what to lead with.
 *
 * Optional by design — Claude is not required for enrichment (see run.ts), so
 * a record without a brief still reaches a seller, just without the prep.
 */

export const CALL_PREP_VERSION = 'v1';

/** The structured brief. Stored on `call_prep_insights`; the prose goes to `call_prep_summary`. */
export interface CallPrepInsights {
  company_summary: string | null;
  key_contact: string | null;
  business_context: string | null;
  suggested_angle: string | null;
  objections_anticipated: string[];
  next_best_action: string | null;
}

export interface CallPrepResult {
  ok: boolean;
  summary: string | null;
  insights: CallPrepInsights | null;
  version: string;
  message?: string;
}

const MODEL = process.env.CALL_PREP_MODEL || 'claude-opus-4-8';

/** Pulls the first fenced JSON block, or falls back to the outermost object. */
function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!candidate?.trim()) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function coerce(raw: unknown): CallPrepInsights | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  return {
    company_summary: str(o.company_summary),
    key_contact: str(o.key_contact),
    business_context: str(o.business_context),
    suggested_angle: str(o.suggested_angle),
    objections_anticipated: Array.isArray(o.objections_anticipated)
      ? o.objections_anticipated.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [],
    next_best_action: str(o.next_best_action),
  };
}

/** Readable prose assembled from the structured fields, for the card in the UI. */
function toSummary(i: CallPrepInsights): string {
  return [
    i.company_summary,
    i.key_contact ? `Contact: ${i.key_contact}` : null,
    i.business_context ? `Why now: ${i.business_context}` : null,
    i.suggested_angle ? `Angle: ${i.suggested_angle}` : null,
    i.objections_anticipated.length ? `Expect: ${i.objections_anticipated.join('; ')}` : null,
    i.next_best_action ? `Next: ${i.next_best_action}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildPrompt(input: EnrichInput, accountName: string | null, contactName: string | null): string {
  const profile = getEnrichmentProfile(input);
  const facts = [
    `Record: ${input.canonical_name}`,
    accountName ? `Company: ${accountName}` : null,
    contactName ? `Contact: ${contactName}${input.contact_title ? `, ${input.contact_title}` : ''}` : null,
    input.record_type ? `Record type: ${input.record_type}` : null,
    [input.city, input.state_province, input.country].filter(Boolean).length
      ? `Location: ${[input.city, input.state_province, input.country].filter(Boolean).join(', ')}`
      : null,
    input.estimated_value
      ? `Estimated value: ${input.estimated_value.toLocaleString()} ${input.estimated_value_currency ?? ''}`.trim()
      : null,
    input.description ? `Description: ${input.description.slice(0, 1200)}` : null,
    input.project_url ? `Source URL: ${input.project_url}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return `You are briefing a sales rep at Evercam before they contact this lead.

Evercam sells construction site cameras and progress-documentation software. Buyers use it for remote site visibility, verified progress evidence in disputes, and capacity planning across multiple sites.

This account is a ${profile.accountRole}.

Known facts about the lead:
${facts}

Write a preparation brief of 250-400 words total. Ground every claim in the facts above or in widely known public information about the company. Where you are inferring rather than asserting, say so ("likely", "typically"). Do not invent named people, specific figures, dates, or events.

Return exactly one fenced JSON block and nothing else:

\`\`\`json
{
  "company_summary": "What this company does and its scale. Max 100 words.",
  "key_contact": "Who to speak to, their likely remit, and what they are measured on.",
  "business_context": "What is happening that makes now the moment — the project stage, expansion, funding, or regulatory pressure.",
  "suggested_angle": "The single strongest opening for THIS lead, tied to a specific Evercam outcome.",
  "objections_anticipated": ["Two to four objections this specific buyer is likely to raise."],
  "next_best_action": "The concrete next step to propose on the call."
}
\`\`\``;
}

/**
 * Generates the brief. Returns `ok: false` with a reason rather than throwing —
 * a missing brief must never fail the enrichment that produced the lead.
 */
export async function generateCallPrep(
  input: EnrichInput,
  context: { accountName?: string | null; contactName?: string | null } = {}
): Promise<CallPrepResult> {
  const empty: CallPrepResult = { ok: false, summary: null, insights: null, version: CALL_PREP_VERSION };

  const apiKey = await readSecret('anthropic_api_key');
  if (!apiKey) return { ...empty, message: 'No Anthropic key configured — call prep is unavailable.' };
  if (!input.canonical_name?.trim()) return { ...empty, message: 'A record with at least a name is required.' };

  try {
    // Capped for the same reason as the enrichment client: this runs inside the
    // same 300-second function, after Claude and Apollo have already spent from
    // it, and call prep is the least essential part of the record. It should
    // give up rather than take the write-back down with it.
    const client = new Anthropic({
      apiKey,
      timeout: Number(process.env.CALL_PREP_TIMEOUT_MS) || 45_000,
      maxRetries: 1,
    });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: buildPrompt(
            input,
            context.accountName ?? input.company_name_raw ?? null,
            context.contactName ?? input.contact_name ?? null
          ),
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const insights = coerce(extractJson(text));
    if (!insights) return { ...empty, message: 'Claude did not return a parseable brief.' };

    // A brief with no usable content is not worth storing — it would show as an
    // empty card and imply the record was prepared when it wasn't.
    const hasContent = Boolean(insights.company_summary || insights.suggested_angle || insights.business_context);
    if (!hasContent) return { ...empty, message: 'Claude returned an empty brief.' };

    return { ok: true, summary: toSummary(insights), insights, version: CALL_PREP_VERSION };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    return {
      ...empty,
      message:
        status === 429
          ? 'Anthropic rate limit reached — call prep skipped.'
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }
}
