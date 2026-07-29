import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { readSecret } from '@/lib/crypto/store';
import { apolloFindContacts } from '@/lib/enrich/apollo';
import type { EnrichedContact } from '@/lib/enrich/types';
import {
  coverageFor,
  titlesFor,
  ROLE_META,
  ROLE_SENIORITIES,
  PLAY_LABELS,
  type BuyingRole,
  type SalesPlay,
  type AccountSize,
} from '@/lib/personas';

/**
 * Filling the buying committee.
 *
 * One ranked Apollo search returns whoever Apollo happens to know, which is
 * rarely a whole committee: plenty of accounts come back with four project
 * managers and no budget holder. The list-quality standard is a shape — two
 * economic buyers, two operational, two champions, two users — so a list is
 * finished when the shape is filled, not when a call returns.
 *
 * So this goes back for what is missing, one role at a time, most decisive
 * first. Apollo is asked with that role's own titles and seniorities, which is
 * a far narrower query than the combined search and finds people the broad one
 * buries. Whatever Apollo still cannot supply is put to Claude, which has web
 * search and can read a company's own leadership page.
 *
 * This costs more per account than a single call — deliberately. A list that
 * is missing its economic buyer costs a BDR a week of calling people who
 * cannot sign, which is more expensive than the credits.
 */

const MODEL = process.env.ENRICH_MODEL || 'claude-opus-4-8';

/** Same person, however the two providers spell them. */
function keyOf(c: { name?: string | null; email?: string | null; linkedin_url?: string | null }): string {
  if (c.email) return `e:${c.email.toLowerCase().trim()}`;
  if (c.linkedin_url) return `l:${c.linkedin_url.toLowerCase().replace(/\/+$/, '')}`;
  return `n:${(c.name ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

function mergeContacts(existing: EnrichedContact[], found: EnrichedContact[]): EnrichedContact[] {
  const seen = new Set(existing.map(keyOf));
  const out = [...existing];
  for (const c of found) {
    // A name is the requirement, not the title: nobody can call "Head of
    // Capital Projects". A title-only result tells us the role exists and
    // nothing more, so it does not belong on a list meant for outreach.
    if (!c.name?.trim()) continue;
    const k = keyOf(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

export interface CommitteeFillOptions {
  play: SalesPlay;
  size?: AccountSize;
  /** Resolved account — Apollo needs a domain or a name to search against. */
  domain?: string | null;
  companyName?: string | null;
  /** Location, to help Claude disambiguate a common company name. */
  location?: string | null;
  /** Apollo contacts to request per role. */
  perRole?: number;
  /** Whether Claude may be asked for what Apollo could not find. */
  useClaude: boolean;
  /** Whether Apollo may be searched per role at all. */
  useApollo?: boolean;
  /**
   * Ceilings for THIS record, from the source's own budget. Null is uncapped.
   * A source Apollo barely covers can be told not to spend four calls proving
   * it, while one it covers well is left alone.
   */
  maxApolloCalls?: number | null;
  maxClaudeCalls?: number | null;
}

export interface CommitteeFillResult {
  contacts: EnrichedContact[];
  /** Provider calls made, so a run can report what it spent. */
  apolloCalls: number;
  claudeCalls: number;
  /** Human-readable trace of what was searched and what came back. */
  notes: string[];
}

/**
 * Ask Claude for named people in specific roles.
 *
 * Deliberately narrow: it is given the roles still missing and the titles that
 * satisfy them, and told that an invented name is worse than an empty result —
 * a fabricated contact wastes a BDR's call and burns the account.
 */
async function claudeFindRoles(
  companyName: string,
  location: string | null,
  play: SalesPlay,
  missing: BuyingRole[]
): Promise<EnrichedContact[]> {
  const apiKey = await readSecret('anthropic_api_key');
  if (!apiKey) return [];

  const wanted = missing
    .map((r) => `- ${ROLE_META[r].label} (${ROLE_META[r].goal}). Titles like: ${titlesFor(play, r).join(', ')}`)
    .join('\n');

  const prompt = `Find named people at this company for a construction-technology sales list.

COMPANY: ${companyName}${location ? `\nLOCATION: ${location}` : ''}
SEGMENT: ${PLAY_LABELS[play]}

We already have some contacts. These roles are still missing:
${wanted}

Use web search. Look at the company's own leadership and team pages, press releases, project announcements, and public professional profiles.

RULES
- Only report a person you actually found in a source. Never guess a name, and never construct an email address from a pattern.
- Include their exact job title as published.
- Include an email or phone ONLY if it appears in a source.
- If you cannot find anyone for a role, return nothing for it. An empty result is correct and useful; an invented one wastes a call and burns the account.

Reply with your research, then END with a single fenced JSON block:
\`\`\`json
{ "contacts": [ { "name": string, "title": string, "email": string|null, "phone": string|null, "linkedin_url": string|null, "source_url": string|null } ] }
\`\`\``;

  try {
    const client = new Anthropic({ apiKey });
    let response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
      messages: [{ role: 'user', content: prompt }],
    });

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
    let guard = 0;
    while (response.stop_reason === 'pause_turn' && guard < 4) {
      guard += 1;
      messages.push({ role: 'assistant', content: response.content });
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
        messages,
      });
    }

    const text = response.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');
    const match = text.match(/```json\s*([\s\S]*?)```/);
    if (!match) return [];

    const parsed = JSON.parse(match[1]) as { contacts?: Record<string, unknown>[] };
    return (parsed.contacts ?? [])
      .filter((c) => typeof c.name === 'string' && (c.name as string).trim())
      .map((c) => ({
        name: (c.name as string) ?? null,
        title: (c.title as string) ?? null,
        email: (c.email as string) ?? null,
        phone: (c.phone as string) ?? null,
        linkedin_url: (c.linkedin_url as string) ?? null,
        source: 'claude',
      }));
  } catch {
    // A gap-fill that fails leaves the list as it was — never fatal.
    return [];
  }
}

export async function fillCommittee(
  existing: EnrichedContact[],
  options: CommitteeFillOptions
): Promise<CommitteeFillResult> {
  const {
    play,
    size = 'enterprise',
    domain,
    companyName,
    location,
    perRole = 3,
    useClaude,
    useApollo = true,
    maxApolloCalls = null,
    maxClaudeCalls = null,
  } = options;
  const notes: string[] = [];
  let contacts = [...existing];
  let apolloCalls = 0;
  let claudeCalls = 0;

  if (!domain && !companyName) {
    return { contacts, apolloCalls, claudeCalls, notes: ['No account resolved — nothing to search against.'] };
  }

  // Apollo, one role at a time, most decisive first. A narrow query surfaces
  // people the combined search buries beneath whoever it ranks highest.
  for (const { role, need } of coverageFor(contacts, size, play).missing) {
    if (!useApollo) break;
    if (maxApolloCalls !== null && apolloCalls >= maxApolloCalls) {
      notes.push(`Apollo · stopped at this source's ceiling of ${maxApolloCalls} call(s).`);
      break;
    }
    const titles = titlesFor(play, role);
    if (titles.length === 0) continue;

    apolloCalls += 1;
    const found = await apolloFindContacts({
      domain,
      companyName,
      limit: Math.max(perRole, need),
      titles,
      seniorities: ROLE_SENIORITIES[role],
    });

    const before = contacts.length;
    contacts = mergeContacts(contacts, found);
    notes.push(`Apollo · ${ROLE_META[role].label}: ${contacts.length - before} new of ${found.length} returned.`);
  }

  // Whatever Apollo could not supply, Claude is asked for by name.
  const stillMissing = coverageFor(contacts, size, play).missing;
  const claudeAllowed = maxClaudeCalls === null || maxClaudeCalls > 0;
  if (useClaude && claudeAllowed && stillMissing.length > 0 && companyName) {
    claudeCalls += 1;
    const roles = stillMissing.map((m) => m.role);
    const found = await claudeFindRoles(companyName, location ?? null, play, roles);
    const before = contacts.length;
    contacts = mergeContacts(contacts, found);
    notes.push(
      `Claude · ${roles.map((r) => ROLE_META[r].label).join(', ')}: ${contacts.length - before} new of ${found.length} returned.`
    );
  }

  const final = coverageFor(contacts, size, play);
  notes.push(
    final.complete
      ? `Committee complete — ${final.total} contacts.`
      : `Still short: ${final.missing.map((m) => `${m.need} ${ROLE_META[m.role].label}`).join(', ')}.`
  );

  return { contacts, apolloCalls, claudeCalls, notes };
}
