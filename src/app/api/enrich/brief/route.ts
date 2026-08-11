import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, isSupabaseServiceConfigured } from '@/lib/supabase/server';
import { getEnrichmentPolicy } from '@/lib/policies';
import { isClaudeConfigured } from '@/lib/enrich/claude';
import { ensureAccountResearch } from '@/lib/enrich/accountResearch';
import { generateSdrBrief } from '@/lib/enrich/sdrBrief';
import { accountIdentity } from '@/lib/keyaccount';
import { checkPermission } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/enrich/brief
 *
 * The qualifying half of enrichment. `/api/enrich/batch` produces a WORKABLE
 * lead — domain, contacts, revealed addresses, all from Apollo, in about thirty
 * seconds. This produces a QUALIFIED one: ICP fit, timing, trigger, the opening
 * hook.
 *
 * Two steps with deliberately different grains, which is what makes it possible
 * at all:
 *
 *   1. COMPANY research — one web-search call, cached in `account_enrichment`
 *      for 90 days. ~60s the first time, free every time after.
 *   2. PROJECT judgement — searchless, ~5s, reading the research from step 1.
 *
 * The first version ran one 16k-token web-search call per RECORD and timed out
 * on every attempt. The corpus is 22,990 records across 11,592 accounts and
 * NextEra Energy alone holds 270, so that design was buying the same paragraph
 * about NextEra 270 times — and each purchase needed more time than the function
 * was allowed to live. Grouping the expensive half by company is the fix; making
 * the cheap half cheap is what lets it keep up.
 *
 * Records are taken oldest-first among those that already have a contact and no
 * ICP score, so a lead a rep can already work is never held up by the part that
 * only makes it easier to open.
 */

/**
 * Records per invocation.
 *
 * Higher than it looks. Step 2 costs about five seconds, so the ceiling is set
 * by how many NEW companies appear in the slice — the accounts already
 * researched cost nothing. Ordering by account below means a batch tends to
 * cluster on the same company, which is exactly the cheap case.
 */
const DEFAULT_LIMIT = 12;

/** Stop starting new work with less than this left, so a record is not cut mid-write. */
const RESERVE_MS = 45_000;
const BUDGET_MS = Number(process.env.BRIEF_BUDGET_MS) || 240_000;

interface BriefResult {
  id: string;
  name: string;
  ok: boolean;
  researchCached: boolean;
  message?: string;
}

export async function POST(request: NextRequest) {
  const auth = await checkPermission('enrichment.run');
  if (!auth.ok) return NextResponse.json({ ok: false, message: auth.message }, { status: auth.status });

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { ok: false, message: 'Supabase service key not configured — briefs are written back, so the service role is required.' },
      { status: 200 }
    );
  }
  if (!(await isClaudeConfigured())) {
    return NextResponse.json(
      { ok: false, message: 'No Anthropic key configured. The brief is entirely Claude — add one in Settings.' },
      { status: 200 }
    );
  }

  let body: { limit?: number; ids?: string[] } = {};
  try {
    body = await request.json();
  } catch {
    // no body — take the default slice off the queue
  }

  const { config: policy } = await getEnrichmentPolicy();
  if (!policy.engines.claude) {
    return NextResponse.json(
      { ok: true, briefed: 0, results: [], message: 'The Claude engine is off in the enrichment policy, so no briefs are generated.' },
      { status: 200 }
    );
  }

  const limit = Math.max(1, Math.min(body.limit ?? DEFAULT_LIMIT, 50));
  const service = getServiceSupabase();

  const columns =
    'id,canonical_name,record_type,icp_code,company_name_raw,company_domain,account_key,contact_name,contact_email,' +
    'description,city,state_province,country,estimated_value,estimated_value_currency,source_key,project_url,vertical,' +
    'current_phase,construction_start_date,estimated_completion_date,announced_date,bid_date';

  let query = service.from('canonical_projects').select(columns);
  if (body.ids?.length) {
    query = query.in('id', body.ids);
  } else {
    query = query
      .not('enriched_at', 'is', null)
      .not('contact_email', 'is', null)
      .is('icp_fit_score', null)
      /*
        ONE sort, not two.

        This ordered by account_key and then enriched_at, and the two-column sort
        over an unindexed predicate sat right on the statement timeout — so the
        same query failed on some runs and succeeded on others. That is what
        "fails hourly, succeeds in the daily run" actually was: a coin flip, not a
        difference between the schedules.

        Measured three times each at the same limit, against 88,126 rows:

          two sorts   7780 | 3524 | 2346 ms   (the cold run crosses the ceiling)
          one sort     810 |  568 |  464 ms
          no sort      356 |  653 |  270 ms

        The spread is the point — a mean would have hidden it. The row limit turns
        out not to matter (90 and 500 cost the same as 30), because the cost is
        the scan, so over-fetching for the grouping below is free.

        The account grouping is worth keeping — records of one company share a
        single piece of research — so it is done in memory below, over the handful
        of rows this returns, instead of by making Postgres sort the whole set.
      */
      .order('enriched_at', { ascending: true });
  }

  /*
    Over-fetch when grouping, so the in-memory pass has whole companies to group
    rather than a slice cut through the middle of one.
  */
  const wantsGrouping = !body.ids?.length;
  const { data: fetched, error } = await query.limit(wantsGrouping ? Math.min(500, limit * 3) : limit);
  if (error) {
    // Name the cause. "Could not read the brief queue" on a statement timeout
    // reads as a mystery, and this one went unexplained for days because of it.
    const timedOut = /statement timeout|canceling statement/i.test(error.message);
    return NextResponse.json(
      {
        ok: false,
        timedOut,
        message: timedOut
          ? `The brief queue read timed out (${error.message}). The predicate is unindexed, so Postgres scans the table to find candidates — apply the brief-queue index.`
          : `Could not read the brief queue: ${error.message}`,
      },
      { status: 200 }
    );
  }

  /*
    Group by account in memory: same benefit as the SQL sort, none of its cost.
    Oldest-first order is preserved within and between accounts, so nothing waits
    indefinitely.
  */
  const rows = wantsGrouping
    ? (() => {
        // Cast through unknown: the select string is concatenated, so supabase-js
        // widens the row type to GenericStringError and every field access fails.
        const all = (fetched ?? []) as unknown as { id: string; account_key?: string | null }[];
        const byAccount = new Map<string, typeof all>();
        for (const r of all) {
          const key = r.account_key ?? `~${r.id}`;
          const bucket = byAccount.get(key);
          if (bucket) bucket.push(r);
          else byAccount.set(key, [r]);
        }
        return [...byAccount.values()].flat().slice(0, limit) as unknown as typeof fetched;
      })()
    : fetched;
  if (!rows?.length) {
    return NextResponse.json(
      { ok: true, briefed: 0, results: [], message: 'Nothing to brief — every enriched record already carries one.' },
      { status: 200 }
    );
  }

  const deadline = Date.now() + BUDGET_MS;
  const results: BriefResult[] = [];
  let briefed = 0;
  let researched = 0;
  let stoppedEarly = false;

  for (const r of rows) {
    if (Date.now() > deadline - RESERVE_MS) {
      stoppedEarly = true;
      break;
    }
    const row = r as unknown as Record<string, unknown>;
    const name = String(row.canonical_name ?? '');
    const company = (row.company_name_raw as string | null) ?? null;

    try {
      // The account key the rest of the app groups by — the resolved domain
      // where there is one, so subsidiaries share their parent's research
      // instead of each buying their own.
      const key =
        (row.account_key as string | null) ??
        accountIdentity(row.company_domain as string | null, company) ??
        null;

      const research = company && key
        ? await ensureAccountResearch(key, company, {
            domain: row.company_domain as string | null,
            vertical: row.vertical as string | null,
          })
        : null;
      if (research && !research.cached) researched++;

      const brief = await generateSdrBrief(row as never, research, company);
      if (!brief.ok || !brief.sdr) {
        results.push({ id: String(row.id), name, ok: false, researchCached: research?.cached ?? false, message: brief.message });
        continue;
      }

      // Only the fields that came back. A null from the model is "I could not
      // say", which must not overwrite something a previous run established.
      const update: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(brief.sdr)) if (v !== null) update[k] = v;
      if (Object.keys(update).length === 0) {
        results.push({ id: String(row.id), name, ok: false, researchCached: research?.cached ?? false, message: 'Nothing to write.' });
        continue;
      }

      const { error: writeError } = await service.from('canonical_projects').update(update).eq('id', row.id as string);
      if (writeError) {
        results.push({ id: String(row.id), name, ok: false, researchCached: research?.cached ?? false, message: writeError.message });
        continue;
      }

      briefed++;
      results.push({ id: String(row.id), name, ok: true, researchCached: research?.cached ?? false });
    } catch (err) {
      results.push({
        id: String(row.id),
        name,
        ok: false,
        researchCached: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  return NextResponse.json({
    ok: true,
    briefed,
    researched,
    attempted: results.length,
    results,
    message:
      `Briefed ${briefed} of ${results.length} record(s)` +
      (researched ? `, researching ${researched} new compan${researched === 1 ? 'y' : 'ies'}` : ', all from cached research') +
      '.' +
      (failed ? ` ${failed} failed and stay queued.` : '') +
      (stoppedEarly ? ' Stopped at the time budget; the rest are picked up next run.' : ''),
  });
}
