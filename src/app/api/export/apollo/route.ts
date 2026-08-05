import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { checkPermission } from '@/lib/auth/session';
import { getEnrichmentPolicy, getExportFieldPolicy } from '@/lib/policies';
import { resolveFieldMap } from '@/lib/export/fieldPolicy';
import { renderRecordBrief } from '@/lib/export/recordBrief';
import { getRoster } from '@/lib/assignmentStore';
import { findApolloUserId } from '@/lib/export/apolloUsers';
import { mapCustomFields, projectSummary, qualifyAccount, qualifyContact } from '@/lib/export/apolloFields';
import { classifyTitle } from '@/lib/personas';
import { exportBatchWithRetry, chunk, APOLLO_BATCH_LIMIT, type ExportContact } from '@/lib/export/apollo';
import { notifyExportFinished } from '@/lib/notify/cliq';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/export/apollo
 *
 * Pushes finished leads into Apollo in batches of 100.
 *
 * Eligibility: a lead needs an owner, an email address, and must not have been
 * sent before. Exporting an unowned contact pollutes the destination list with
 * records nobody is working, which is worse than exporting nothing.
 *
 * Whether the address must be VERIFIED follows `requireChannel`. With no
 * verification tool connected, requiring it held every lead at the last step
 * with nothing able to clear it — so unverified leads travel, and they travel
 * marked: the response counts them, and `email_verified` on the record stays
 * false so nobody downstream mistakes an unconfirmed address for a checked one.
 */
export async function POST(request: NextRequest) {
  const auth = await checkPermission('leads.export');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ok: false, message: 'Supabase service key not configured.' }, { status: 200 });
  }

  let body: {
    dryRun?: boolean;
    limit?: number;
    bu?: string;
    label?: string;
    trigger?: 'manual' | 'cron';
    /**
     * Export one person's leads only — a roster id, or their name.
     *
     * A name is accepted because that is how anyone asks for this ("export
     * Ronniel's leads"), and the roster is five people, not five thousand. It
     * must resolve to exactly one active member: see the refusals below.
     */
    assignee?: string;
  } = {};
  try {
    body = await request.json();
  } catch {
    // no body — run with defaults
  }

  const { config: policy } = await getEnrichmentPolicy();
  // Read once for the whole run, not once per contact: it is one document, and
  // `mapCustomFields` is called for every member of every committee.
  const { config: fieldPolicy } = await getExportFieldPolicy();
  const fieldMap = resolveFieldMap(fieldPolicy);
  const service = getServiceSupabase();
  const startedAtMs = Date.now();
  const limit = Math.max(1, Math.min(1000, body.limit ?? policy.apolloBatchSize ?? APOLLO_BATCH_LIMIT));

  // Verification is required only while the policy asks for it. With no
  // verification tool connected — and Apollo's api_search returning whether an
  // address exists rather than the address itself — insisting on `email_verified`
  // held every lead at the last step with nothing able to clear it. Unverified
  // leads now export and travel WITH that fact: `email_verified` stays false and
  // `email_validation_source` records how it was checked, so the receiving end
  // can tell a confirmed address from an unconfirmed one.
  const requireVerified = policy.requireChannel;

  /**
   * The roster, read before the query rather than after it, because it now has
   * two jobs: spending each person's daily quota, and resolving `body.assignee`
   * into the id the query filters on.
   */
  const { data: rosterRows } = await service.from('assignees').select('id, name, email, daily_lead_quota').eq('is_active', true);
  const activeRoster = (rosterRows ?? []) as { id: string; name: string; email: string; daily_lead_quota: number | null }[];

  /**
   * Resolve one person, or refuse.
   *
   * The refusal matters more than the match. If an unrecognised name fell
   * through to an unfiltered query, "export to Ronniel" would send everybody's
   * leads to Apollo and archive them — irreversible from here, and reported as a
   * success. So an `assignee` that does not resolve to exactly one active member
   * stops the run and names the alternatives.
   */
  let assigneeFilter: { id: string; name: string } | null = null;
  if (body.assignee?.trim()) {
    const needle = body.assignee.trim().toLowerCase();
    const matches = activeRoster.filter(
      (a) =>
        a.id === body.assignee ||
        a.email?.toLowerCase() === needle ||
        a.name?.toLowerCase() === needle ||
        a.name?.toLowerCase().includes(needle)
    );

    if (matches.length === 0) {
      return NextResponse.json({
        ok: false,
        message:
          `No active roster member matches "${body.assignee}". ` +
          `Active: ${activeRoster.map((a) => a.name).join(', ') || 'nobody'}.`,
      });
    }
    if (matches.length > 1) {
      return NextResponse.json({
        ok: false,
        message: `"${body.assignee}" matches ${matches.length} people: ${matches.map((a) => a.name).join(', ')}. Use a full name or the roster id.`,
      });
    }
    assigneeFilter = { id: matches[0].id, name: matches[0].name };
  }

  let query = service
    .from('canonical_projects')
    .select(
      // One literal, not a concatenation: PostgREST select strings are parsed as
      // literal types, so building this from pieces collapses the row type to
      // GenericStringError. Every column the brief renders is here — selecting
      // only the summary ones made the brief omit whole sections silently.
      'id, canonical_name, contact_name, contact_email, contact_phone, contact_title, contact_linkedin_url, email_verified, phone_verified, company_name_raw, company_website, country, bu, priority_score, assignee_id, apollo_account_id, apollo_account_name, additional_contacts, contact_role, opening_hook, pain_point, trigger_event, value_angle, icp_fit_score, icp_fit_reason, call_prep_summary, project_type, current_phase, estimated_value, source_key, ref_code, description, building_type, project_url, estimated_value_currency, square_footage, number_of_floors, capacity_mw, technology_type, address_line1, city, state_province, is_remote_location, is_access_constrained, announced_date, construction_start_date, estimated_completion_date, bid_date, evercam_timing, priority_band, priority_reasons, committee_coverage, vertical, enriched_at, route, stage'
    )
    .is('apollo_exported_at', null)
    // Ownership is assignee_id now — owner_user_id is null for everyone on the
    // roster without an app account, so this filter found nothing.
    .not('assignee_id', 'is', null)
    .eq('do_not_contact', false)
    /*
      Either channel, not email only.

      This used to demand `contact_email`, which silently overrode the
      `channelRules` policy: with act_now set to 'phone', a lead carrying a phone
      and no address was excluded here and the run reported "nothing eligible" —
      the export enforcing a rule the configuration had already answered.

      Which channel a given lead actually needs depends on its lane, and that is
      decided per row below. This only narrows to rows that have SOMETHING to
      reach a person by.

      `additional_contacts` counts as something. Testing only the primary columns
      excluded any lead whose committee is populated but whose primary contact is
      empty, and the committee is where the people usually are: Brasfield & Gorrie
      carries THIRTEEN named contacts with real addresses and a null primary, so
      the export never fetched it at all. That is the single genuinely-contactable
      lead in the current book, and it was invisible.
    */
    .or('contact_email.not.is.null,contact_phone.not.is.null,additional_contacts.neq.[]')
    .in('status', ['ASSIGNED', 'CONTACTED', 'PREPARED'])
    .order('priority_score', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (requireVerified) query = query.eq('email_verified', true);
  if (body.bu) query = query.eq('bu', body.bu);
  if (assigneeFilter) query = query.eq('assignee_id', assigneeFilter.id);

  const { data, error } = await query;
  if (error) {
    const hint = /does not exist|schema cache/i.test(error.message) ? ' Run the apollo_export migration first.' : '';
    return NextResponse.json({ ok: false, message: `${error.message}.${hint}` }, { status: 200 });
  }

  const fetched = (data ?? []) as Record<string, unknown>[];

  /**
   * One person's day of leads, per person — not a global top-N.
   *
   * The query orders by priority across the whole book, so a single global limit
   * handed the strongest leads to whoever happened to own them. With Anas on a
   * quota of 50 and Ronniel on 10, a limit of 10 could send Anas ten leads and
   * Ronniel none, every run, forever — and nothing in the output would say so.
   *
   * Each active person's `daily_lead_quota` is their own ceiling. Leads stay in
   * priority order within a person, so trimming to quota drops their weakest,
   * not somebody else's strongest.
   */
  const quotaOf = new Map(activeRoster.map((r) => [r.id, r.daily_lead_quota ?? 0]));

  const takenPerAssignee = new Map<string, number>();
  const overQuota: string[] = [];
  const rows = fetched.filter((r) => {
    const owner = String(r.assignee_id ?? '');
    // Somebody assigned but no longer on the active roster has no quota to spend.
    // Skipping them loudly beats sending on behalf of a deactivated account.
    const quota = quotaOf.get(owner);
    if (quota === undefined) {
      if (!overQuota.includes('unrostered')) overQuota.push('unrostered');
      return false;
    }
    const taken = takenPerAssignee.get(owner) ?? 0;
    if (taken >= quota) {
      const name = activeRoster.find((x) => x.id === owner)?.name ?? owner;
      if (!overQuota.includes(name)) overQuota.push(name);
      return false;
    }
    takenPerAssignee.set(owner, taken + 1);
    return true;
  });

  if (rows.length === 0) {
    /**
     * Say WHICH reason applied, not which reasons exist.
     *
     * This used to list every gate — owner, email, do-not-contact, already sent —
     * and leave the reader to work out which one had bitten. Asked of a real
     * roster it took a database session to answer: 22 of that person's 29 leads
     * were already in Apollo and the other 7 had no contact at all, so the export
     * was behaving perfectly and the message could not say so.
     *
     * Counted, not enumerated: this runs when there is nothing to send, so a
     * handful of head-only counts costs nothing and turns an ambiguous sentence
     * into a diagnosis.
     */
    const scope = assigneeFilter ? ` for ${assigneeFilter.name}` : '';

    /**
     * Filters as data, not as a builder callback.
     *
     * Threading the PostgREST builder through a generic helper makes the compiler
     * give up with "type instantiation is excessively deep", and the casts needed
     * to silence that are worse than the duplication they save.
     */
    type Cond =
      | { column: string; op: 'eq' | 'neq'; value: string | boolean }
      | { column: string; op: 'isNull' | 'notNull' };
    const countOf = async (conds: Cond[]): Promise<number> => {
      let q = service.from('canonical_projects').select('id', { count: 'exact', head: true });
      // Every count is over ASSIGNED leads, optionally narrowed to one person, so
      // the denominator matches the run the caller actually asked for.
      q = q.not('assignee_id', 'is', null);
      if (assigneeFilter) q = q.eq('assignee_id', assigneeFilter.id);
      for (const c of conds) {
        if (c.op === 'eq') q = q.eq(c.column, c.value);
        else if (c.op === 'neq') q = q.neq(c.column, c.value);
        else if (c.op === 'isNull') q = q.is(c.column, null);
        else q = q.not(c.column, 'is', null);
      }
      const { count } = await q;
      return count ?? 0;
    };

    const UNSENT: Cond = { column: 'apollo_exported_at', op: 'isNull' };
    const [assigned, alreadySent, noEmail, blocked, unverified] = await Promise.all([
      countOf([]),
      countOf([{ column: 'apollo_exported_at', op: 'notNull' }]),
      countOf([UNSENT, { column: 'contact_email', op: 'isNull' }]),
      countOf([UNSENT, { column: 'do_not_contact', op: 'eq', value: true }]),
      requireVerified
        ? countOf([UNSENT, { column: 'contact_email', op: 'notNull' }, { column: 'email_verified', op: 'neq', value: true }])
        : Promise.resolve(0),
    ]);

    const because: string[] = [];
    if (alreadySent) because.push(`${alreadySent} already sent to Apollo`);
    if (noEmail) because.push(`${noEmail} with no email address`);
    if (unverified) because.push(`${unverified} whose email is not verified`);
    if (blocked) because.push(`${blocked} flagged do-not-contact`);
    // Named, because "held back at quota" is the one reason that fixes itself
    // tomorrow and the one reason nothing else on the page surfaces.
    if (overQuota.length) because.push(`held back at daily quota: ${overQuota.join(', ')}`);

    const diagnosis =
      assigned === 0
        ? ' Nobody is assigned any leads at all — run assignment first.'
        : because.length
          ? ` Of ${assigned} assigned: ${because.join(', ')}.`
          : '';

    return NextResponse.json({
      ok: true,
      message:
        `Nothing eligible${scope}.${diagnosis}` +
        (unverified && requireVerified
          ? ' Turn off "Require a validated phone or email" in Settings to send unverified addresses.'
          : '') +
        (noEmail && !unverified && !alreadySent
          ? ' The export cannot invent an address — those need enrichment to find a contact.'
          : ''),
      requested: 0,
      created: 0,
      existing: 0,
      failed: 0,
      // The same breakdown as data, so a caller does not have to parse prose.
      blockedBy: { assigned, alreadySent, noEmail, unverified, doNotContact: blocked, atQuota: overQuota },
    });
  }

  // Stated, not implied. An export that quietly includes unconfirmed addresses
  // is how a sales tool fills with bounces nobody can account for.
  const unverifiedEmails = rows.filter((r) => r.email_verified !== true).length;
  const unverifiedPhones = rows.filter((r) => r.contact_phone && r.phone_verified !== true).length;
  const caveat =
    unverifiedEmails > 0 || unverifiedPhones > 0
      ? ` ${unverifiedEmails} email${unverifiedEmails === 1 ? '' : 's'}` +
        (unverifiedPhones > 0 ? ` and ${unverifiedPhones} phone${unverifiedPhones === 1 ? '' : 's'}` : '') +
        ' unverified.'
      : '';

  // Who owns each lead, and their Apollo user id — that is what puts a BDR's
  // name on the contact instead of leaving it unowned. Resolved once for the
  // whole batch rather than per contact.
  const { rows: roster } = await getRoster();
  const byAssignee = new Map(roster.map((a) => [a.id, a]));
  const apolloUserByRoster = new Map<string, string | null>();
  for (const a of roster) {
    apolloUserByRoster.set(a.id, await findApolloUserId(a.email, a.name));
  }

  const contacts: ExportContact[] = [];
  /**
   * Contacts whose title does not match the buying-role guide.
   *
   * These used to be dropped, which is the wrong trade for a contact we have
   * already paid Apollo to reveal. The persona guide is a description of who is
   * usually worth calling, not a fact about who can be called — and it does not
   * know every title in the industry. Held against a real list it removed the
   * ONLY contact on two of Ronniel's leads, on the strength of "Section Manager"
   * not being one of the four manager phrases it happens to enumerate. A rep
   * looking at that lead saw nothing at all, and nothing said why.
   *
   * So an unrecognised title is now a flag, not a gate: the contact travels, and
   * it travels marked — the same trade already made for unverified emails a few
   * lines above. The rep decides; the tool tells them what it thinks.
   */
  const unqualified: { name: string; title: string | null; reason: string }[] = [];

  /**
   * Contacts their lane cannot reach.
   *
   * Counted and named rather than silently dropped, because "nothing eligible"
   * with no reason is the failure this whole diagnosis chain exists to end. A
   * contact listed here has a name but not the channel its lane demands.
   */
  const unreachable: { name: string; needs: string }[] = [];

  /**
   * Contacts named after the company line because enrichment found no person.
   *
   * Reported rather than hidden: a rep should know they are being handed a
   * switchboard, not somebody's desk. Previously these were dropped, which lost
   * the number too.
   */
  let placeholderNames = 0;

  /**
   * What happened to the custom fields, gathered across the whole batch.
   *
   * Apollo accepts a field it will not store and answers 200, so the only signal
   * that `Qualify Account` never arrives is this report. Deduplicated by name
   * because these are properties of the workspace, not of one contact.
   */
  const fieldIssues = {
    unmatched: new Set<string>(),
    duplicated: new Set<string>(),
    unsupported: new Map<string, string>(),
    truncated: new Map<string, { name: string; from: number; to: number }>(),
  };

  for (const r of rows) {
    const owner = r.assignee_id ? byAssignee.get(r.assignee_id as string) : undefined;

    const shared = {
      leadId: r.id as string,
      organizationName: (r.company_name_raw as string) ?? null,
      website: (r.company_website as string) ?? null,
      // An explicit id, never a domain: five accounts here share one domain.
      accountId: (r.apollo_account_id as string) ?? null,
      ownerId: owner ? (apolloUserByRoster.get(owner.id) ?? null) : null,
      // One Apollo list per BDR — the "sheet per BDR" the handoff asks for.
      label: body.label ?? (owner ? `LDR — ${owner.name}` : null),
      firstName: null,
      lastName: null,
    };

    // The primary contact AND the rest of the committee. They were paid for on
    // the same Apollo call, and a list of one is not the eight-contact standard.
    const committee = [
      {
        name: (r.contact_name as string) ?? null,
        title: (r.contact_title as string) ?? null,
        email: (r.contact_email as string) ?? null,
        phone: (r.contact_phone as string) ?? null,
        linkedin_url: (r.contact_linkedin_url as string) ?? null,
      },
      ...((((r.additional_contacts as unknown[]) ?? []) as {
        name?: string | null;
        title?: string | null;
        email?: string | null;
        phone?: string | null;
        linkedin_url?: string | null;
      }[]) ?? []),
    ];

    /*
      What this lane needs to reach somebody, from the policy rather than from here.

      `channelRules` is keyed by stage: with act_now on 'phone', a phone is
      sufficient and an address is not required. An unknown stage falls back to
      'any', which is the permissive reading — the alternative is silently
      dropping a lead because nobody has written a rule for its lane yet.
    */
    const laneChannel = policy.channelRules[String(r.stage ?? '')] ?? 'any';
    const reachable = (person: { email?: string | null; phone?: string | null }): boolean => {
      const hasEmail = Boolean(person.email);
      const hasPhone = Boolean(person.phone);
      switch (laneChannel) {
        case 'email':
          return hasEmail;
        case 'phone':
          return hasPhone;
        case 'both':
          return hasEmail && hasPhone;
        case 'none':
          return true;
        default:
          return hasEmail || hasPhone;
      }
    };

    for (const person of committee) {
      /*
        A NAME is still non-negotiable, whatever the channel rule says.

        Apollo accepts a contact with neither name nor email and files it as
        "(No Name)", which tells a rep nothing. But a reachable number is worth
        having even when enrichment never found a person: 111 records carry a
        company line and no name, and dropping them lost the number as well as
        the name.

        So a nameless contact WITH a channel is named for what it actually is —
        the company's main line — rather than either invented as a person or
        thrown away. `${company} — Main Line` is unambiguous in a list, dedupes to
        one record per company rather than one per project, and reads as a
        switchboard so nobody calls it expecting Bruce.

        Nothing at all — no name AND no channel — is still dropped. There is
        genuinely nothing to send.
      */
      let personName = person?.name?.trim() || null;
      let isPlaceholder = false;
      if (!personName) {
        if (!person?.email && !person?.phone) continue;
        const org = (r.company_name_raw as string)?.trim();
        if (!org) continue; // no company either — nothing to name it after
        personName = `${org} — Main Line`;
        isPlaceholder = true;
        placeholderNames += 1;
      }

      /*
        A placeholder says so in its title as well as its name.

        The name alone could still be mistaken for a person in a list view, and
        the title is the field a rep reads next. Saying it plainly is cheaper than
        a rep discovering it on the call.
      */
      const personTitle = isPlaceholder ? 'Company main line — no named contact found yet' : (person.title ?? null);

      const personForReach = { email: person?.email, phone: person?.phone };
      if (!reachable(personForReach)) {
        unreachable.push({ name: personName, needs: laneChannel });
        continue;
      }

      /*
        A placeholder is not a person, so the persona guide has nothing to say
        about it. Running classifyTitle here would flag every switchboard as an
        unrecognised title and bury the real flags in noise.
      */
      const role = isPlaceholder ? null : classifyTitle(person.title);
      if (!role && !isPlaceholder) {
        unqualified.push({ name: personName, title: person.title ?? null, reason: 'title not in the persona guide' });
      }

      /**
       * The custom fields, per person rather than per record.
       *
       * Two of them genuinely differ by person — the title, and the buying-role
       * verdict written into `Qualify Contact` — so building them once per record
       * put the primary contact's title on every member of the committee. The
       * field definitions are cached for the process, so this costs no extra
       * Apollo calls.
       */
      // This person's own buying role, not the record's. `contact_role` describes
      // the primary contact, so passing it through put "Buying role: economic" on
      // every committee member regardless of their title.
      const isPrimary = !isPlaceholder && person.email === r.contact_email;
      const personRole = role ?? (isPrimary ? ((r.contact_role as string) ?? null) : null);

      const custom = await mapCustomFields({
        canonical_name: r.canonical_name as string,
        project_summary: projectSummary(r as never),
        call_prep_summary: r.call_prep_summary as string,
        qualify_account: qualifyAccount(r as never),
        // The verdict reaches the rep where they already look for "why this
        // person". A flag nobody sees is the same as no flag.
        qualify_contact: [
          qualifyContact(r as never, personRole),
          /*
            The persona warning is for PEOPLE.

            A switchboard has no title to recognise, so warning that its title is
            unrecognised is noise on the one field a rep reads for "why this
            person" — and it landed on the live record reading "no title on file"
            under a name that already says Main Line. Placeholders get a line that
            is actually true instead.
          */
          isPlaceholder
            ? 'No named contact found yet — this is the company line. Ask for whoever runs the project.'
            : role
              ? null
              : `⚠ Title not recognised by the persona guide${person.title ? ` ("${person.title}")` : ' (no title on file)'} — confirm the role before calling.`,
        ]
          .filter(Boolean)
          .join('\n'),
        project_signal: r.source_key as string,
        contact_title: personTitle ?? (r.contact_title as string),
        // The whole record. Rendered per person so the committee list can mark
        // which member this contact is.
        record_brief: renderRecordBrief(r as never, person.email),
      }, fieldMap);

      // Field-level problems are per-contact but almost always systemic, so they
      // are collected once and reported rather than discarded. Silently dropping
      // these is how `Qualify Account` was "sent" on every run and never landed.
      for (const name of custom.unmatched) fieldIssues.unmatched.add(name);
      for (const name of custom.duplicated) fieldIssues.duplicated.add(name);
      for (const u of custom.unsupported) fieldIssues.unsupported.set(u.name, u.modality);
      for (const t of custom.truncated) {
        const prev = fieldIssues.truncated.get(t.name);
        // Keep the worst offender, so the report shows the real overshoot.
        if (!prev || t.from > prev.from) fieldIssues.truncated.set(t.name, t);
      }

      contacts.push({
        ...shared,
        customFields: custom.values,
        name: personName,
        title: personTitle,
        // Null, not undefined: an email is no longer guaranteed to be present
        // now that a phone-only lane can export, and `toApolloPayload` omits a
        // null rather than sending the key with nothing in it.
        email: person.email ?? null,
        phone: person.phone ?? null,
        linkedinUrl: person.linkedin_url ?? null,
      });
    }
  }

  /**
   * Flagged titles, stated in the message.
   *
   * Deliberately worded as "flagged", never "skipped" — the counts now mean
   * opposite things, and reading one as the other would have someone chasing
   * contacts that were in fact sent.
   */
  const flagCaveat = unqualified.length
    ? ` ${unqualified.length} title${unqualified.length === 1 ? '' : 's'} flagged for review, not held back.`
    : '';

  /**
   * Contacts held because their lane's channel is missing.
   *
   * Named with the channel it wanted, so the reader can tell "needs a phone" from
   * "needs an email" — the two have completely different remedies, and the policy
   * that decided it is editable in Settings.
   */
  /*
    Placeholders, stated. A rep opening "Barnard Construction — Main Line" should
    already know from the run report that it is a switchboard and not a person
    somebody researched.
  */
  const namelessCaveat = placeholderNames
    ? ` ${placeholderNames} had no named person, so ${placeholderNames === 1 ? 'it is' : 'they are'} sent as the company main line — call and ask for the project team.`
    : '';

  const reachCaveat = unreachable.length
    ? ` ${unreachable.length} contact${unreachable.length === 1 ? '' : 's'} held for want of the channel their lane requires (` +
      [...new Set(unreachable.map((u) => u.needs))].map((n) => `needs ${n}`).join(', ') +
      ').'
    : '';

  /**
   * The custom-field report, in the response body.
   *
   * Stated in the message too, because a field that cannot land changes what a
   * rep sees on the contact, and nobody reads a key they were not told about.
   */
  const fieldReport = {
    unmatched: [...fieldIssues.unmatched],
    duplicated: [...fieldIssues.duplicated],
    unsupported: [...fieldIssues.unsupported.entries()].map(([name, modality]) => ({ name, modality })),
    truncated: [...fieldIssues.truncated.values()],
  };
  const fieldCaveat =
    (fieldReport.unsupported.length
      ? ` ${fieldReport.unsupported.length} field${fieldReport.unsupported.length === 1 ? '' : 's'} cannot be written on a contact (${fieldReport.unsupported
          .map((u) => `${u.name} is ${u.modality}-level`)
          .join('; ')}).`
      : '') +
    (fieldReport.truncated.length
      ? ` Truncated to Apollo's limit: ${fieldReport.truncated.map((t) => `${t.name} ${t.from}→${t.to}`).join(', ')}.`
      : '') +
    (fieldReport.unmatched.length ? ` Not found in Apollo: ${fieldReport.unmatched.join(', ')}.` : '');

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      message:
        `${contacts.length} contact${contacts.length === 1 ? '' : 's'}` +
        (assigneeFilter ? ` for ${assigneeFilter.name}` : '') +
        ` would be sent to Apollo in ${chunk(contacts).length} batch(es).${caveat}${flagCaveat}${reachCaveat}${namelessCaveat}${fieldCaveat}`,
      assignee: assigneeFilter?.name ?? null,
      requested: contacts.length,
      batches: chunk(contacts).length,
      fields: fieldReport,
      unreachable: unreachable.slice(0, 20),
      unreachableCount: unreachable.length,
      placeholderNames,
      preview: contacts.slice(0, 10).map((c) => ({
        name: c.name,
        title: c.title,
        email: c.email,
        company: c.organizationName,
        list: c.label,
        ownedInApollo: Boolean(c.ownerId),
        accountResolved: Boolean(c.accountId),
        // So the preview shows which of these a rep should sanity-check.
        titleFlagged: unqualified.some((u) => u.name === c.name && u.title === c.title),
      })),
      // Named rather than counted: "12 flagged" is not actionable, a list is.
      // `skipped` is kept as a key for one release because the checklist and the
      // cron report read it, but nothing is skipped for a title any more — these
      // contacts were all included.
      flagged: unqualified.slice(0, 20),
      flaggedCount: unqualified.length,
      skipped: [],
      skippedCount: 0,
    });
  }

  // Open the run row first, so an interrupted export still leaves a trace.
  let runId: string | null = null;
  try {
    const { data: run } = await service
      .from('export_runs')
      .insert({
        destination: 'apollo',
        trigger: body.trigger ?? 'manual',
        triggered_by: auth.user.id,
        // The assignee belongs in the audit trail: "who was this run for" is the
        // first question asked of a targeted export after the fact.
        filters: {
          bu: body.bu ?? null,
          limit,
          label: body.label ?? null,
          assignee: assigneeFilter?.name ?? null,
          assigneeId: assigneeFilter?.id ?? null,
        },
        requested: contacts.length,
        status: 'running',
      })
      .select('id')
      .maybeSingle();
    runId = (run as { id: string } | null)?.id ?? null;
  } catch {
    // history is best-effort
  }

  let created = 0;
  let existing = 0;
  let failed = 0;
  // Owner and list are a second call per contact, so they can fail on their own.
  // Counted separately: an unowned contact is in Apollo, just not on a desk.
  let enriched = 0;
  let enrichFailed = 0;
  const allResults = [];
  const batches = chunk(contacts);

  for (const batch of batches) {
    const outcome = await exportBatchWithRetry(batch, { dedupe: true });
    enriched += outcome.enriched ?? 0;
    enrichFailed += outcome.enrichFailed ?? 0;

    for (const r of outcome.results) {
      if (r.outcome === 'created') created += 1;
      else if (r.outcome === 'existing') existing += 1;
      else failed += 1;

      // Only a successful send stamps apollo_exported_at — a failed lead must
      // stay eligible for the next run rather than being silently skipped.
      const patch: Record<string, unknown> =
        r.outcome === 'failed'
          ? { apollo_export_status: 'failed', apollo_export_error: r.error ?? outcome.message ?? 'Unknown error' }
          : {
              apollo_exported_at: new Date().toISOString(),
              apollo_contact_id: r.apolloContactId,
              apollo_export_status: r.outcome,
              apollo_export_error: null,
            };

      await service.from('canonical_projects').update(patch).eq('id', r.leadId);
    }

    allResults.push(...outcome.results);

    // A hard failure (bad key, rejected payload) will repeat on every
    // remaining batch — stop rather than burning the whole queue against it.
    if (!outcome.ok && !outcome.retryable) break;
  }

  const durationMs = Date.now() - startedAtMs;
  if (runId) {
    try {
      await service
        .from('export_runs')
        .update({
          created,
          existing,
          failed,
          batches: batches.length,
          results: allResults.slice(0, 500),
          // `failed === contacts.length` alone called a run with nothing to send
          // a failure, because 0 === 0. Two cron runs sit in the history marked
          // failed with zero failures for exactly that reason. A run only failed
          // if something actually did.
          status: failed > 0 && failed === contacts.length ? 'failed' : 'completed',
          finished_at: new Date().toISOString(),
          duration_ms: durationMs,
        })
        .eq('id', runId);
    } catch {
      // best-effort
    }
  }

  /**
   * Tell the team, because Apollo will not.
   *
   * Deliberately after the run row is closed: the export is durable by this
   * point, so a chat outage costs a notice, never a record. The result is
   * reported in the response rather than acted on — an unsent notice is worth
   * knowing about, but it is not a failed export.
   */
  const perAssignee = [...takenPerAssignee.entries()].map(([id, count]) => ({
    name: activeRoster.find((r) => r.id === id)?.name ?? id,
    count,
  }));
  const notice = await notifyExportFinished({
    requested: contacts.length,
    created,
    existing,
    failed,
    perAssignee,
    atQuota: overQuota,
    flagged: unqualified.length,
    ownerOrListFailed: enrichFailed,
    trigger: body.trigger ?? 'manual',
    assignee: assigneeFilter?.name ?? null,
    durationMs,
  });

  return NextResponse.json({
    // Same guard as the run row: an empty send is not a failed one.
    ok: failed === 0 || failed < contacts.length,
    message:
      `Sent ${contacts.length}${assigneeFilter ? ` for ${assigneeFilter.name}` : ''} to Apollo — ${created} created, ${existing} already there${failed ? `, ${failed} failed` : ''}.${caveat}${flagCaveat}${reachCaveat}${namelessCaveat}${fieldCaveat}` +
      // Owner and list are what make a contact somebody's to call. If they did
      // not stick, the export "succeeded" into an unassigned pile.
      (enrichFailed ? ` ${enrichFailed} could not be assigned an owner or list.` : '') +
      // Per-person trimming, said out loud. Otherwise a run that stopped at
      // somebody's quota looks identical to one that ran out of leads, and the
      // difference decides whether you raise a quota or enrich more.
      (overQuota.length
        ? ` Held back at daily quota: ${overQuota.join(', ')}.`
        : '') +
      ` Per person: ${[...takenPerAssignee.entries()]
        .map(([id, n]) => `${(rosterRows ?? []).find((x) => (x as { id: string }).id === id)?.['name'] ?? id} ${n}`)
        .join(', ') || 'nobody'}.`,
    requested: contacts.length,
    created,
    existing,
    failed,
    owned: enriched,
    ownerOrListFailed: enrichFailed,
    fields: fieldReport,
    unreachableCount: unreachable.length,
    placeholderNames,
    // 'not-configured' until someone pastes a Cliq URL in Settings — stated so a
    // silent chat is a visible fact rather than a mystery.
    notified: notice.sent,
    notifyReason: notice.sent ? null : notice.reason,
    batches: batches.length,
    durationMs,
  });
}
