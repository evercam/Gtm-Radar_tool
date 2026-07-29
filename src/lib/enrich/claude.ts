import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { EnrichInput, EnrichedAccount, EnrichedContact, EnrichedNews, SdrIntel } from './types';
import { getEnrichmentProfile, type EnrichmentProfile } from './profiles';
import { readSecret } from '@/lib/crypto/store';

/**
 * Claude enrichment engine. Given a raw record, Claude identifies the ACCOUNT
 * (the company behind the project), mines recent news/entities via the web
 * search server tool, and proposes candidate contacts. Uses Claude Opus 4.8
 * with adaptive thinking; the model returns a single fenced ```json block that
 * we parse (kept separate from Apollo's verified contacts downstream).
 *
 * The API key resolves from the encrypted `app_secrets` table first and then
 * from ANTHROPIC_API_KEY, so a key saved in Settings works without a restart.
 */

const MODEL = process.env.ENRICH_MODEL || 'claude-opus-4-8';

export interface ClaudeEnrichment {
  account: EnrichedAccount | null;
  contacts: EnrichedContact[];
  news: EnrichedNews[];
  sdr: SdrIntel | null;
  reasoning: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
}

export async function isClaudeConfigured(): Promise<boolean> {
  return Boolean(await readSecret('anthropic_api_key'));
}

function buildPrompt(input: EnrichInput, profile: EnrichmentProfile): string {
  const facts = [
    `Project/record name: ${input.canonical_name}`,
    input.record_type ? `Record type: ${input.record_type}` : null,
    input.company_name_raw ? `Company/organization mentioned: ${input.company_name_raw}` : null,
    input.description ? `Description: ${input.description.slice(0, 1200)}` : null,
    [input.city, input.state_province, input.country].filter(Boolean).length
      ? `Location: ${[input.city, input.state_province, input.country].filter(Boolean).join(', ')}`
      : null,
    input.estimated_value != null
      ? `Value: ${input.estimated_value_currency ?? ''} ${input.estimated_value.toLocaleString()}`
      : null,
    input.source_key ? `Discovered via source: ${input.source_key}` : null,
    input.project_url ? `Source URL: ${input.project_url}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return `You are a construction-industry sales researcher for Evercam. Given a construction/energy/procurement record, identify the ACCOUNT — the company or organization behind it that we would sell to — and gather actionable intelligence.

SOURCE CONTEXT — ${profile.accountRole}:
${profile.guidance}
When proposing contacts, prioritise these kinds of roles: ${profile.apolloTitles.join(', ')}.

RECORD:
${facts}

TASKS:
1. Identify the primary account (company/organization) following the SOURCE CONTEXT above. Determine its likely website domain, industry, HQ location, and its ROLE on this project (owner / developer / general_contractor / operator / public_body / other).
2. Use web search to find RECENT news about this project and this company (funding, awards, expansions, leadership). Prefer sources from the last 24 months.
3. Propose up to 5 likely decision-maker CONTACTS at the account (name + title; include email/phone/LinkedIn ONLY if you find them in a source — never invent contact details).
3a. LINKEDIN PROFILES are required on every contact you propose. Search for the person's public profile and return its URL exactly as published. A BDR uses it to confirm the person still holds that role before spending a call, so a profile for the wrong person is worse than none — if you cannot confirm the profile belongs to this person at this company, return null.
3b. PHONE NUMBERS are a priority for this team. Search specifically for publicly listed numbers and return every one you can source: the company switchboard, the regional or site office nearest this project, and the procurement or main reception desk. Put the best one on account.phone in full international format (e.g. +1 208 368 4000). If you find a number published against a named person, put it on that contact. Only report a number that appears on a page you actually read — an invented phone number is worse than none, because someone will dial it.
4. State your confidence (high/medium/low) and briefly how you identified the account.
5. ACCOUNT INTELLIGENCE — resolve the company's identity and portfolio: its parent company; related entities (subsidiaries / JV partners) and their roles; and OTHER active construction projects this entity owns or builds (name, location, stage, estimated value). Estimate the total portfolio value, revenue band, and any current expansion/funding/pipeline signal, and note any construction tech they use (Procore / Autodesk ACC / Primavera).
6. SDR PLAYBOOK — for a sales rep selling Evercam (AI site cameras + construction intelligence): score ICP fit 0-100 with a one-line reason; judge Evercam timing (reach_now = mobilising/on-site soon, watch = planned, too_early = early planning, too_late = operating/complete); name the trigger event; write a one-line opening_hook referencing THIS project; pick the value_angle (confidence = independent verification for owners; evidence = defensible record for GCs; capacity = remote/constrained-site coverage); and state the pain_point Evercam solves here.

Do NOT fabricate emails, phone numbers, or names. Leave a field null if unknown. A phone number you are not sure about must be null.

Respond with your research, then END your reply with a single fenced JSON block in exactly this shape:
\`\`\`json
{
  "account": {
    "name": string|null, "domain": string|null, "website": string|null,
    "industry": string|null, "role": string|null, "hq_location": string|null, "phone": string|null,
    "employee_count": number|null, "linkedin_url": string|null, "description": string|null,
    "parent_account": string|null,
    "related_entities": [ { "name": string|null, "role": string|null, "relationship": string|null } ],
    "related_projects": [ { "name": string|null, "location": string|null, "stage": string|null, "est_value": number|null } ],
    "portfolio_value_estimate": number|null, "revenue_band": string|null,
    "expansion_signal": string|null, "tech_stack": [string]
  },
  "contacts": [
    { "name": string|null, "title": string|null, "email": string|null, "phone": string|null, "linkedin_url": string|null }
  ],
  "news": [
    { "title": string|null, "url": string|null, "summary": string|null, "published": string|null }
  ],
  "sdr": {
    "icp_fit_score": number|null, "icp_fit_reason": string|null,
    "evercam_timing": "reach_now"|"watch"|"too_early"|"too_late"|null,
    "trigger_event": string|null, "opening_hook": string|null,
    "value_angle": "confidence"|"evidence"|"capacity"|null, "pain_point": string|null
  },
  "confidence": "high"|"medium"|"low",
  "reasoning": string
}
\`\`\``;
}

/** Pull the last fenced ```json block from Claude's text. */
function extractJson(text: string): unknown | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const block = matches.length ? matches[matches.length - 1][1] : null;
  const raw = block ?? text;
  try {
    return JSON.parse(raw.trim());
  } catch {
    // Fallback: try to find the outermost {...}
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(raw.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function collectText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export async function enrichWithClaude(input: EnrichInput): Promise<ClaudeEnrichment> {
  // The key is passed explicitly rather than left to the SDK's env lookup, so
  // a key saved in Settings is used even when no env var exists.
  const apiKey = await readSecret('anthropic_api_key');
  if (!apiKey) throw new Error('No Anthropic API key configured. Add one in Settings.');
  const client = new Anthropic({ apiKey });
  const profile = getEnrichmentProfile(input);

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: buildPrompt(input, profile) }];

  let response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
    messages,
  });

  // Server-tool (web search) loop: resume while the turn is paused.
  let guard = 0;
  while (response.stop_reason === 'pause_turn' && guard < 6) {
    guard += 1;
    messages.push({ role: 'assistant', content: response.content });
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
      messages,
    });
  }

  const text = collectText(response.content);
  const parsed = extractJson(text) as {
    account?: (Partial<EnrichedAccount> & Record<string, unknown>) | null;
    contacts?: Partial<EnrichedContact>[];
    news?: Partial<EnrichedNews>[];
    sdr?: Partial<SdrIntel> | null;
    confidence?: 'high' | 'medium' | 'low';
    reasoning?: string;
  } | null;

  if (!parsed) {
    return {
      account: null,
      contacts: [],
      news: [],
      sdr: null,
      reasoning: text.slice(0, 500) || null,
      confidence: null,
    };
  }

  const num = (v: unknown): number | null => (typeof v === 'number' && !Number.isNaN(v) ? v : null);
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

  const account: EnrichedAccount | null = parsed.account
    ? {
        name: parsed.account.name ?? null,
        domain: parsed.account.domain ?? null,
        website: parsed.account.website ?? null,
        industry: parsed.account.industry ?? null,
        role: parsed.account.role ?? null,
        hq_location: parsed.account.hq_location ?? null,
        phone: (parsed.account.phone as string) ?? null,
        employee_count: num(parsed.account.employee_count),
        linkedin_url: parsed.account.linkedin_url ?? null,
        description: parsed.account.description ?? null,
        parent_account: (parsed.account.parent_account as string) ?? null,
        related_entities: arr(parsed.account.related_entities),
        related_projects: arr(parsed.account.related_projects),
        portfolio_value_estimate: num(parsed.account.portfolio_value_estimate),
        revenue_band: (parsed.account.revenue_band as string) ?? null,
        expansion_signal: (parsed.account.expansion_signal as string) ?? null,
        tech_stack: arr<string>(parsed.account.tech_stack),
      }
    : null;

  const sdr: SdrIntel | null = parsed.sdr
    ? {
        icp_fit_score: num(parsed.sdr.icp_fit_score),
        icp_fit_reason: parsed.sdr.icp_fit_reason ?? null,
        evercam_timing: parsed.sdr.evercam_timing ?? null,
        trigger_event: parsed.sdr.trigger_event ?? null,
        opening_hook: parsed.sdr.opening_hook ?? null,
        value_angle: parsed.sdr.value_angle ?? null,
        pain_point: parsed.sdr.pain_point ?? null,
      }
    : null;

  const contacts: EnrichedContact[] = (parsed.contacts ?? [])
    .filter((c) => c && (c.name || c.title))
    .map((c) => ({
      name: c.name ?? null,
      title: c.title ?? null,
      email: c.email ?? null,
      phone: c.phone ?? null,
      linkedin_url: c.linkedin_url ?? null,
      source: 'claude',
    }));

  const news: EnrichedNews[] = (parsed.news ?? [])
    .filter((n) => n && (n.title || n.url))
    .map((n) => ({
      title: n.title ?? null,
      url: n.url ?? null,
      summary: n.summary ?? null,
      published: n.published ?? null,
    }));

  return {
    account,
    contacts,
    news,
    sdr,
    reasoning: parsed.reasoning ?? null,
    confidence: parsed.confidence ?? null,
  };
}
