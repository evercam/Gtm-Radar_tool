import 'server-only';
import { enrichWithClaude, isClaudeConfigured, type ClaudeEnrichment } from '@/lib/enrich/claude';
import { apolloFindContacts, apolloFindOrganization, isApolloConfigured } from '@/lib/enrich/apollo';
import type { EnrichInput, EnrichResult, EnrichedContact } from '@/lib/enrich/types';
import { planEnrichmentApply, type AppliedField } from '@/lib/provenance';
import { getEnrichmentProfile } from '@/lib/enrich/profiles';
import { accountKey, scoreKeyAccount } from '@/lib/keyaccount';
import { gleifLookup } from '@/lib/enrich/gleif';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { DEFAULT_ENRICHMENT_POLICY, type EnrichmentPolicy } from '@/lib/enrich/policy';
import { transitionLead } from '@/lib/lifecycleStore';
import { validateForChannel } from '@/lib/enrich/validate';
import { requiredChannel } from '@/lib/lifecycle';
import { generateCallPrep } from '@/lib/enrich/callPrep';
import { classifyEnrichError } from '@/lib/enrich/errors';
import { searchTitles, playFor, classifyTitle, coverageFor, ROLE_META, type BuyingRole } from '@/lib/personas';
import { fillCommittee } from '@/lib/enrich/committee';
import type { SourceBudget } from '@/lib/enrich/sourceBudget';
import { apolloRevealPhone } from '@/lib/enrich/apolloPhone';
import { resolveApolloAccount } from '@/lib/enrich/apolloAccount';

/**
 * The enrichment run itself, extracted from the /api/enrich route so the batch
 * endpoint can call it directly instead of re-entering the app over HTTP.
 *
 * One record in, one EnrichResult out:
 *   resolve the ACCOUNT — Claude when available, otherwise Apollo's own
 *   company index
 *   → Apollo finds verified contacts at that account
 *   → GLEIF adds verified corporate hierarchy
 *   → the key-account rubric scores the account
 *   → the contact is validated against the channel the record's lane needs
 *   → when the record has a persisted id, everything is written back with
 *     per-field provenance, an enrichment_jobs entry and a lifecycle move.
 *
 * APOLLO IS REQUIRED; Claude is optional. Apollo is what produces workable
 * contacts, so without it there is nothing to enrich with. Claude improves
 * account resolution and adds SDR intelligence, but the run proceeds without
 * it — falling back to an Apollo organization search for the domain its people
 * search needs.
 *
 * A record whose lane requires a channel it doesn't have is HELD at
 * PENDING_ENRICHMENT rather than promoted: an Act Now lead with no verified
 * phone is not workable, and promoting it wastes a seller's time.
 */
export async function runEnrichment(
  input: EnrichInput,
  policy: EnrichmentPolicy = DEFAULT_ENRICHMENT_POLICY,
  /**
   * What this record's SOURCE allows. Resolved once per batch and passed in,
   * because a batch spans many sources and re-reading the configs per record
   * would be a query per lead.
   */
  budget: SourceBudget = {
    claude: policy.engines.claude,
    apollo: policy.engines.apollo,
    fillCommittee: policy.fillCommittee,
    maxApolloCalls: null,
    maxClaudeCalls: null,
    overridden: false,
  }
): Promise<EnrichResult> {
  const empty = {
    account: null,
    contacts: [],
    news: [],
    reasoning: null,
    confidence: null,
    engines: { claude: false, apollo: false },
  };

  // Apollo is the required engine: it is what actually produces verified
  // contacts, and a record without one cannot be worked. Claude is optional —
  // it improves account resolution and adds SDR intelligence, but enrichment
  // proceeds without it.
  if (!policy.engines.apollo || !(await isApolloConfigured())) {
    return {
      ok: false,
      ...empty,
      message: policy.engines.apollo
        ? 'No Apollo API key configured. Apollo is required for enrichment — add a key in Settings.'
        : 'The Apollo engine is disabled in the enrichment policy, so no contacts can be found.',
    } satisfies EnrichResult;
  }
  if (!input.canonical_name?.trim()) {
    return { ok: false, ...empty, message: 'A record with at least a name is required.' } satisfies EnrichResult;
  }

  try {
    // Personalize enrichment to the source (energy owner vs contractor vs
    // public buyer vs news operator vs public company vs developer).
    const profile = getEnrichmentProfile(input);

    const claudeAvailable = budget.claude && (await isClaudeConfigured());
    const claude: ClaudeEnrichment = claudeAvailable
      ? await enrichWithClaude(input)
      : { account: null, contacts: [], news: [], sdr: null, reasoning: null, confidence: null };

    // Resolving the account is the step Apollo cannot do alone: its people
    // search needs a domain. Claude normally supplies it; without Claude we ask
    // Apollo's own company index instead, which keeps Apollo genuinely
    // standalone at the cost of one extra call.
    let account = claude.account;
    let accountSource: 'claude' | 'apollo' | null = account?.name ? 'claude' : null;
    // The company switchboard, if Apollo knows it. Apollo's people search
    // never returns direct dials — those cost 8 credits each through the
    // reveal endpoint — so this is the only number most contacts will carry.
    let switchboard: string | null = claude.account?.phone ?? null;

    if (!account?.domain && input.company_name_raw?.trim()) {
      const location = [input.city, input.state_province, input.country].filter(Boolean).join(', ');
      const org = await apolloFindOrganization(account?.name || input.company_name_raw, location || null);
      if (org?.domain || org?.name) {
        accountSource = account?.name ? accountSource : 'apollo';
        switchboard = org.phone ?? null;
        account = {
          // Claude's findings win where it has them; Apollo fills the gaps.
          name: account?.name ?? org.name,
          domain: account?.domain ?? org.domain,
          website: account?.website ?? org.website,
          industry: account?.industry ?? org.industry,
          role: account?.role ?? null,
          hq_location: account?.hq_location ?? org.location,
          // Claude's number wins if it found one; otherwise Apollo's switchboard.
          phone: account?.phone ?? org.phone,
          employee_count: account?.employee_count ?? org.employeeCount,
          linkedin_url: account?.linkedin_url ?? org.linkedinUrl,
          description: account?.description ?? null,
          parent_account: account?.parent_account ?? null,
          related_entities: account?.related_entities ?? [],
          related_projects: account?.related_projects ?? [],
          portfolio_value_estimate: account?.portfolio_value_estimate ?? null,
          revenue_band: account?.revenue_band ?? null,
          expansion_signal: account?.expansion_signal ?? null,
          tech_stack: account?.tech_stack ?? [],
        };
      }
    }

    // Apollo contact search, targeting the roles that matter for this account type.
    let apolloContacts: EnrichedContact[] = [];
    const apolloRan = budget.apollo && Boolean(account?.domain || account?.name || input.company_name_raw);
    if (apolloRan) {
      apolloContacts = await apolloFindContacts({
        domain: account?.domain,
        companyName: account?.name ?? input.company_name_raw,
        limit: policy.contactsPerAccount,
        // A profile's titles are tuned to that source, so they win; the policy
        // list only fills the gap for sources that name none.
        // The buying committee for this record's sales play, most decisive
        // role first, so a trimmed result set loses site engineers rather than
        // the budget holder. A source profile still wins where it has titles —
        // it knows things about that feed the play cannot.
        titles: profile.apolloTitles?.length
          ? profile.apolloTitles
          : searchTitles(playFor(input.vertical, input.icp_code)).slice(0, 25),
        seniorities: policy.contactSeniorities,
        fallbackPhone: switchboard,
      });
    }

    // Merge contacts: Apollo (verified) first, then Claude candidates not already covered by name.
    const seen = new Set(apolloContacts.map((c) => (c.name ?? '').toLowerCase()).filter(Boolean));
    const merged: EnrichedContact[] = [
      ...apolloContacts,
      ...claude.contacts.filter((c) => {
        const key = (c.name ?? '').toLowerCase();
        if (key && seen.has(key)) return false;
        if (key) seen.add(key);
        return true;
      }),
    ];

    // Key-account verdict from Claude's portfolio findings (rubric in lib/keyaccount).
    const acctKey = accountKey(account?.name || input.company_name_raw);
    const relatedProjects = account?.related_projects ?? [];

    // GLEIF (keyless): verified corporate hierarchy — parent + subsidiaries.
    const gleif = policy.engines.gleif ? await gleifLookup(account?.name || input.company_name_raw) : null;
    const parentAccount = gleif?.parent?.name ?? account?.parent_account ?? null;
    const relatedEntities = [
      ...(gleif?.parent
        ? [{ name: gleif.parent.name, role: 'parent', relationship: 'ultimate_parent', lei: gleif.parent.lei }]
        : []),
      ...(gleif?.subsidiaries ?? []).map((s) => ({
        name: s.name,
        role: 'subsidiary',
        relationship: 'subsidiary',
        lei: s.lei,
      })),
      ...(account?.related_entities ?? []),
    ];

    const ka = scoreKeyAccount({
      relatedProjectsCount: relatedProjects.length,
      portfolioValue: account?.portfolio_value_estimate ?? null,
      role: account?.role ?? null,
      icpCode: input.icp_code ?? null,
      vertical: null,
      projectValue: input.estimated_value ?? null,
      expansionSignal: account?.expansion_signal ?? null,
      subsidiaryCount: gleif?.subsidiaryTotal ?? 0,
    });
    const keyAccount = { key_account: ka.isKey, key_account_score: ka.score, key_account_reasons: ka.reasons };

    // Work out which columns enrichment would fill (empty-only, so source data
    // is preserved) and, when we have a persisted row id, write them back with
    // per-field provenance + an enrichment_jobs entry.
    /**
     * Rank by where each person sits in the decision, not by the order Apollo
     * happened to return them. The primary contact should be the most
     * decisive one found — a Director of Construction outranks a site manager
     * regardless of who came back first.
     */
    const play = playFor(input.vertical, input.icp_code);

    // One search rarely returns a whole committee, so go back for what is
    // missing before deciding who the primary contact is — otherwise the
    // choice is made from an incomplete set.
    let committee = merged;
    let committeeNotes: string[] = [];
    if (budget.fillCommittee && (account?.domain || account?.name || input.company_name_raw)) {
      const filled = await fillCommittee(merged, {
        play,
        size: policy.committeeSize,
        domain: account?.domain,
        companyName: account?.name ?? input.company_name_raw,
        location: [input.city, input.state_province, input.country].filter(Boolean).join(', ') || null,
        perRole: policy.contactsPerRole,
        useClaude: budget.claude && claudeAvailable,
        useApollo: budget.apollo,
        maxApolloCalls: budget.maxApolloCalls,
        maxClaudeCalls: budget.maxClaudeCalls,
      });
      committee = filled.contacts;
      committeeNotes = filled.notes;
    }

    const ranked = committee
      .map((c) => ({ contact: c, role: classifyTitle(c.title, play) }))
      .sort((a, b) => (a.role ? ROLE_META[a.role].priority : 0) < (b.role ? ROLE_META[b.role].priority : 0) ? 1 : -1);

    const topContact = ranked[0]?.contact ?? null;
    const topRole: BuyingRole | null = ranked[0]?.role ?? null;
    // Everyone else, kept rather than discarded — they were paid for, and the
    // standard needs eight of them per enterprise account.
    const extraContacts = ranked.slice(1).map(({ contact, role }) => ({
      name: contact.name ?? null,
      title: contact.title ?? null,
      email: contact.email ?? null,
      phone: contact.phone ?? null,
      linkedin_url: contact.linkedin_url ?? null,
      role,
      source: contact.source ?? null,
    }));
    const coverage = coverageFor(committee, policy.committeeSize, play);
    // Direct dials, only when asked for. Apollo charges 8 credits per number
    // and answers through a webhook, so this runs for the single chosen
    // contact rather than everyone found, and only when the policy says so.
    let phoneReveal: string | null = null;
    if (
      policy.revealPhoneNumbers &&
      policy.maxPhoneRevealsPerRun > 0 &&
      input.id &&
      topContact?.name &&
      !topContact.phone
    ) {
      const [firstName, ...rest] = topContact.name.split(/\s+/);
      const outcome = await apolloRevealPhone(
        {
          recordId: input.id,
          name: topContact.name,
          firstName,
          lastName: rest.join(' ') || null,
          email: topContact.email,
          domain: account?.domain,
          organizationName: account?.name ?? input.company_name_raw,
          linkedinUrl: topContact.linkedin_url,
        },
        policy.phoneWebhookUrl
      );
      // An inline number is rare but free to use; otherwise the webhook fills
      // it in later and the record keeps whatever fallback it already had.
      if (outcome.phones[0]) topContact.phone = outcome.phones[0];
      phoneReveal = outcome.message;
    }

    // Which Apollo account this belongs to, resolved once and stored. The
    // export must never match on domain: five accounts in this workspace share
    // balfourbeatty.com and the country field does not tell them apart.
    let apolloAccount: { id: string; name: string; crmUrl: string | null } | null = null;
    let accountNote: string | null = null;
    if (budget.apollo && (account?.name || input.company_name_raw)) {
      const resolved = await resolveApolloAccount({
        companyName: account?.name ?? input.company_name_raw,
        domain: account?.domain,
        country: input.country,
      });
      if (resolved.status === 'matched') {
        apolloAccount = {
          id: resolved.account.id,
          name: resolved.account.name,
          crmUrl: resolved.account.crmRecordUrl,
        };
        accountNote = `Apollo account: ${resolved.account.name} (${resolved.confidence}).`;
      } else if (resolved.status === 'ambiguous') {
        // Left unresolved on purpose. A contact on the wrong account syncs into
        // the wrong CRM record and nobody notices, which is worse than one
        // that simply has not been filed yet.
        accountNote = `Apollo account unresolved — ${resolved.reason}`;
      }
    }

    let applied: AppliedField[] = planEnrichmentApply(
      input as unknown as Record<string, unknown>,
      account,
      topContact
    ).fieldsAdded;
    let persisted = false;
    // Hoisted: validation happens inside the persistence block (it needs the
    // stored row's lane), but the result reports it either way.
    let channelForResult: { required: string; satisfied: boolean; missing: string[] } | null = null;

    if (input.id && isSupabaseServiceConfigured()) {
      try {
        const supabase = getServiceSupabase();
        const { data: row } = await supabase
          .from('canonical_projects')
          .select(
            'company_name_raw, company_website, company_domain, contact_name, contact_title, contact_email, contact_phone, field_provenance, enrichment_jobs'
          )
          .eq('id', input.id)
          .maybeSingle();

        if (row) {
          const plan = planEnrichmentApply(row as Record<string, unknown>, account, topContact);
          applied = plan.fieldsAdded;

          // SDR intelligence + account_key are Claude-derived — refresh each run.
          const sdrUpdate: Record<string, unknown> = {};
          const sdrProv: Record<string, string> = {};
          if (claude.sdr) {
            for (const [k, v] of Object.entries(claude.sdr)) {
              if (v !== null && v !== undefined) {
                sdrUpdate[k] = v;
                sdrProv[k] = 'claude';
              }
            }
          }
          if (acctKey) {
            sdrUpdate.account_key = acctKey;
            sdrProv.account_key = 'claude';
          }

          const now = new Date().toISOString();
          const job = {
            at: now,
            engines: { claude: claudeAvailable, apollo: apolloRan, gleif: Boolean(gleif) },
            fields_added: [...plan.fieldsAdded.map((f) => f.field), ...Object.keys(sdrUpdate)],
            account: account?.name ?? null,
            account_source: accountSource,
            confidence: claude.confidence,
          };
          // How much of what we wanted did we actually get? Drives the
          // enrichment_completeness column and the "to verify" flag.
          const engines = [
            claudeAvailable ? 'claude' : null,
            apolloRan ? 'apollo' : null,
            gleif ? 'gleif' : null,
          ].filter(Boolean);
          const completeness = Math.min(
            1,
            (Number(Boolean(account?.name)) +
              Number(Boolean(topContact?.email || topContact?.phone)) +
              Number(Boolean(account?.domain))) /
              3
          );

          // Validate the channel this record's lane actually works through.
          // Act Now is a phone motion, Nurture an email motion — a record
          // missing its required channel is not workable, so it stays queued
          // rather than being handed to a seller who cannot act on it.
          const channel = requiredChannel((row as Record<string, unknown>).stage as string | null, policy.channelRules);
          const validation = await validateForChannel(channel, {
            email: (plan.updates.contact_email as string) ?? (row.contact_email as string) ?? null,
            phone: (plan.updates.contact_phone as string) ?? (row.contact_phone as string) ?? null,
          });
          channelForResult = { required: channel, satisfied: validation.satisfied, missing: validation.missing };

          const { error } = await supabase
            .from('canonical_projects')
            .update({
              ...plan.updates,
              ...sdrUpdate,
              // The rest of the committee, kept rather than discarded. These
              // were paid for on the same Apollo call as the primary.
              additional_contacts: extraContacts,
              ...(apolloAccount
                ? {
                    apollo_account_id: apolloAccount.id,
                    apollo_account_name: apolloAccount.name,
                    crm_record_url: apolloAccount.crmUrl,
                  }
                : {}),
              contact_role: topRole,
              committee_coverage: {
                size: coverage.size,
                found: coverage.found,
                missing: coverage.missing,
                total: coverage.total,
                target: coverage.target,
                complete: coverage.complete,
              },
              email_verified: validation.email?.valid ?? false,
              email_confidence: validation.email?.confidence ?? 0,
              email_role_based: validation.email?.roleBased ?? false,
              email_domain_exists: validation.email?.domainExists ?? false,
              email_validation_source: validation.email?.source ?? null,
              phone_verified: validation.phone?.valid ?? false,
              phone_confidence: validation.phone?.confidence ?? 0,
              phone_type: validation.phone?.type ?? null,
              phone_validation_source: validation.phone?.source ?? null,
              enrichment_errors: validation.satisfied
                ? null
                : [`Missing required ${validation.missing.join(' and ')} for this lane`],
              field_provenance: { ...((row.field_provenance as object) ?? {}), ...plan.provenance, ...sdrProv },
              enrichment_jobs: [...((row.enrichment_jobs as unknown[]) ?? []), job],
              // stamped so a batch can skip records enriched recently (policy.reenrichAfterDays)
              enriched_at: now,
              last_enrichment_attempt: now,
              enrichment_source: engines.join('+') || null,
              enrichment_completeness: Number(completeness.toFixed(2)),
            })
            .eq('id', input.id);
          persisted = !error;

          // The lifecycle move is separate so it is validated against the
          // transition graph and appended to the record's history, rather than
          // being set inline where a bad jump would go unnoticed.
          if (persisted) {
            if (validation.satisfied) {
              await transitionLead(input.id, 'ENRICHED', {
                actor: 'enrichment',
                reason: account?.name ? `Resolved ${account.name}` : 'Enrichment completed',
              });

              // The brief is what a seller actually reads before dialling, so
              // it is generated as soon as the record becomes workable. It is
              // optional: a failure here leaves the record ENRICHED and
              // usable, just without the prep.
              if (policy.generateCallPrep !== false && claudeAvailable) {
                const prep = await generateCallPrep(
                  { ...input, contact_name: topContact?.name ?? input.contact_name },
                  { accountName: account?.name, contactName: topContact?.name }
                );
                if (prep.ok) {
                  const { error: prepError } = await supabase
                    .from('canonical_projects')
                    .update({
                      call_prep_summary: prep.summary,
                      call_prep_insights: prep.insights,
                      call_prep_generated_at: new Date().toISOString(),
                      call_prep_version: prep.version,
                    })
                    .eq('id', input.id);
                  if (!prepError) {
                    await transitionLead(input.id, 'PREPARED', {
                      actor: 'call_prep',
                      reason: 'Call brief generated',
                    });
                  }
                }
              }
            } else {
              // Held, not failed: the record keeps everything enrichment found
              // and is retried once a later pass can supply the missing
              // channel. Marking it ENRICHED would promote an unworkable lead.
              await transitionLead(input.id, 'PENDING_ENRICHMENT', {
                actor: 'enrichment',
                reason: `Held — no verified ${validation.missing.join(' or ')}`,
              });
            }
          }

          // Upsert the account-level enrichment (one row per account_key).
          if (acctKey && account) {
            const a = account;
            const acctProv: Record<string, string> = {};
            for (const f of [
              'account_name',
              'account_role',
              'related_projects',
              'portfolio_value_estimate',
              'expansion_signal',
              'key_account',
              'key_account_score',
            ])
              acctProv[f] = 'claude';
            // Hierarchy comes from GLEIF when available (verified registry), else Claude.
            for (const f of ['account_name', 'account_role']) acctProv[f] = accountSource ?? 'claude';
            acctProv.parent_account = gleif?.parent ? 'gleif' : 'claude';
            acctProv.related_entities = gleif ? 'gleif' : 'claude';
            await supabase.from('account_enrichment').upsert(
              {
                account_key: acctKey,
                account_name: a.name,
                account_role: a.role,
                parent_account: parentAccount,
                related_entities: relatedEntities,
                related_projects: relatedProjects,
                portfolio_project_count: relatedProjects.length,
                portfolio_value_estimate: a.portfolio_value_estimate ?? null,
                revenue_band: a.revenue_band ?? null,
                employee_count: a.employee_count ?? null,
                expansion_signal: a.expansion_signal ?? null,
                tech_stack: a.tech_stack ?? [],
                key_account: ka.isKey,
                key_account_score: ka.score,
                key_account_reasons: ka.reasons,
                field_provenance: acctProv,
                enrichment_jobs: [job],
              },
              { onConflict: 'account_key' }
            );
          }
        }
      } catch {
        // Persistence is best-effort — still return the enrichment inline.
      }
    }

    const mergedAccount = account
      ? { ...account, parent_account: parentAccount, related_entities: relatedEntities }
      : null;

    return {
      ok: true,
      account: mergedAccount,
      // The filled committee, not the first pass — otherwise every contact
      // the gap-fill found goes unreported.
      contacts: committee,
      news: claude.news,
      reasoning: claude.reasoning,
      confidence: claude.confidence,
      engines: { claude: claudeAvailable, apollo: apolloRan },
      profile: profile.accountRole,
      sdr: claude.sdr,
      keyAccount,
      applied,
      persisted,
      channel: channelForResult,
      phoneReveal,
      coverage: {
        complete: coverage.complete,
        total: coverage.total,
        target: coverage.target,
        missing: coverage.missing,
        notes: accountNote ? [...committeeNotes, accountNote] : committeeNotes,
      },
    } satisfies EnrichResult;
  } catch (err) {
    const classified = classifyEnrichError(err);
    return {
      ok: false,
      ...empty,
      errorKind: classified.kind,
      fatal: classified.fatal,
      message: classified.message,
    } satisfies EnrichResult;
  }
}
