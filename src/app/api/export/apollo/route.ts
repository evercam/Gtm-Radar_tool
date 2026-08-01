import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { checkPermission } from '@/lib/auth/session';
import { getEnrichmentPolicy } from '@/lib/policies';
import { getRoster } from '@/lib/assignmentStore';
import { findApolloUserId } from '@/lib/export/apolloUsers';
import { mapCustomFields, projectSummary, qualifyAccount, qualifyContact } from '@/lib/export/apolloFields';
import { isQualifiedTitle } from '@/lib/personas';
import { exportBatchWithRetry, chunk, APOLLO_BATCH_LIMIT, type ExportContact } from '@/lib/export/apollo';

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

  let body: { dryRun?: boolean; limit?: number; bu?: string; label?: string; trigger?: 'manual' | 'cron' } = {};
  try {
    body = await request.json();
  } catch {
    // no body — run with defaults
  }

  const { config: policy } = await getEnrichmentPolicy();
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

  let query = service
    .from('canonical_projects')
    .select(
      'id, canonical_name, contact_name, contact_email, contact_phone, contact_title, contact_linkedin_url, email_verified, phone_verified, company_name_raw, company_website, country, bu, priority_score, assignee_id, apollo_account_id, apollo_account_name, additional_contacts, contact_role, opening_hook, pain_point, trigger_event, value_angle, icp_fit_score, icp_fit_reason, call_prep_summary, project_type, current_phase, estimated_value, source_key'
    )
    .is('apollo_exported_at', null)
    // Ownership is assignee_id now — owner_user_id is null for everyone on the
    // roster without an app account, so this filter found nothing.
    .not('assignee_id', 'is', null)
    .eq('do_not_contact', false)
    // An address is always required — there is nothing to export without one.
    .not('contact_email', 'is', null)
    .in('status', ['ASSIGNED', 'CONTACTED', 'PREPARED'])
    .order('priority_score', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (requireVerified) query = query.eq('email_verified', true);
  if (body.bu) query = query.eq('bu', body.bu);

  const { data, error } = await query;
  if (error) {
    const hint = /does not exist|schema cache/i.test(error.message) ? ' Run the apollo_export migration first.' : '';
    return NextResponse.json({ ok: false, message: `${error.message}.${hint}` }, { status: 200 });
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) {
    return NextResponse.json({
      ok: true,
      message: requireVerified
        ? 'Nothing eligible — leads need an owner, a VERIFIED email, no do-not-contact flag, and must not have been sent already. Turn off "Require a validated phone or email" in Settings to export unverified addresses.'
        : 'Nothing eligible — leads need an owner, an email address, no do-not-contact flag, and must not have been sent already.',
      requested: 0,
      created: 0,
      existing: 0,
      failed: 0,
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
  /** Titles too junior or unrelated to belong on a BDR list. */
  const skipped: { name: string; title: string | null; reason: string }[] = [];

  for (const r of rows) {
    const owner = r.assignee_id ? byAssignee.get(r.assignee_id as string) : undefined;

    const custom = await mapCustomFields({
      canonical_name: r.canonical_name as string,
      project_summary: projectSummary(r as never),
      call_prep_summary: r.call_prep_summary as string,
      qualify_account: qualifyAccount(r as never),
      qualify_contact: qualifyContact(r as never),
      project_signal: r.source_key as string,
      contact_title: r.contact_title as string,
    });

    const shared = {
      leadId: r.id as string,
      organizationName: (r.company_name_raw as string) ?? null,
      website: (r.company_website as string) ?? null,
      // An explicit id, never a domain: five accounts here share one domain.
      accountId: (r.apollo_account_id as string) ?? null,
      ownerId: owner ? (apolloUserByRoster.get(owner.id) ?? null) : null,
      // One Apollo list per BDR — the "sheet per BDR" the handoff asks for.
      label: body.label ?? (owner ? `LDR — ${owner.name}` : null),
      customFields: custom.values,
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

    for (const person of committee) {
      if (!person?.name || !person.email) continue;
      if (!isQualifiedTitle(person.title)) {
        skipped.push({ name: person.name, title: person.title ?? null, reason: 'title not qualified' });
        continue;
      }
      contacts.push({
        ...shared,
        name: person.name,
        title: person.title ?? null,
        email: person.email,
        phone: person.phone ?? null,
        linkedinUrl: person.linkedin_url ?? null,
      });
    }
  }

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      message: `${contacts.length} contact${contacts.length === 1 ? '' : 's'} would be sent to Apollo in ${chunk(contacts).length} batch(es).${caveat}`,
      requested: contacts.length,
      batches: chunk(contacts).length,
      preview: contacts.slice(0, 10).map((c) => ({
        name: c.name,
        title: c.title,
        email: c.email,
        company: c.organizationName,
        list: c.label,
        ownedInApollo: Boolean(c.ownerId),
        accountResolved: Boolean(c.accountId),
      })),
      // Named rather than counted: "12 skipped" is not actionable, a list is.
      skipped: skipped.slice(0, 20),
      skippedCount: skipped.length,
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
        filters: { bu: body.bu ?? null, limit, label: body.label ?? null },
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
  const allResults = [];
  const batches = chunk(contacts);

  for (const batch of batches) {
    const outcome = await exportBatchWithRetry(batch, { dedupe: true });

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
          status: failed === contacts.length ? 'failed' : 'completed',
          finished_at: new Date().toISOString(),
          duration_ms: durationMs,
        })
        .eq('id', runId);
    } catch {
      // best-effort
    }
  }

  return NextResponse.json({
    ok: failed < contacts.length,
    message: `Sent ${contacts.length} to Apollo — ${created} created, ${existing} already there${failed ? `, ${failed} failed` : ''}.${caveat}`,
    requested: contacts.length,
    created,
    existing,
    failed,
    batches: batches.length,
    durationMs,
  });
}
