'use client';

import { useMemo, useState } from 'react';
import { calculateCost, costPerOutcome, DEFAULT_RATES, type CostRates } from '@/lib/costs';
import { Badge, Button, Card, CardHeader, Label, Stat, controlClass } from '@/components/ui';

export interface CostContext {
  /** Records sitting in PENDING_ENRICHMENT right now. */
  queued: number;
  dailyCap: number;
  monthlyCap: number;
  batchSize: number;
  claudeEnabled: boolean;
  callPrepEnabled: boolean;
  apolloEnabled: boolean;
  contactsPerAccount: number;
  revealPhones: boolean;
  maxPhoneReveals: number;
  /** Observed from enrichment_runs: contacts found ÷ records attempted. */
  observedContactRate: number | null;
  observedRuns: number;
}

const money = (n: number) =>
  n >= 100 ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : `$${n.toFixed(2)}`;

/**
 * What a run will cost before you start it.
 *
 * Enrichment spends across three providers in three units — Anthropic bills
 * tokens, Apollo bills credits, GLEIF bills nothing — so the only way to
 * answer "can I afford to raise the daily cap" was to do the arithmetic by
 * hand. Every unit price is editable because provider pricing changes, and a
 * number that silently goes stale is worse than no number.
 */
export default function CostCalculator({ ctx }: { ctx: CostContext }) {
  const [records, setRecords] = useState(ctx.queued || ctx.batchSize || 100);
  const [rates, setRates] = useState<CostRates>(DEFAULT_RATES);
  const [showRates, setShowRates] = useState(false);

  const [claude, setClaude] = useState(ctx.claudeEnabled);
  const [callPrep, setCallPrep] = useState(ctx.callPrepEnabled);
  const [apollo, setApollo] = useState(ctx.apolloEnabled);
  const [reveal, setReveal] = useState(ctx.revealPhones);
  const [contacts, setContacts] = useState(ctx.contactsPerAccount);
  const [phoneHitRate, setPhoneHitRate] = useState(0.5);

  const breakdown = useMemo(
    () =>
      calculateCost(
        {
          records,
          claudeEnabled: claude,
          callPrepEnabled: claude && callPrep,
          apolloEnabled: apollo,
          contactsPerAccount: contacts,
          revealPhones: apollo && reveal,
          maxPhoneReveals: ctx.maxPhoneReveals || records,
          phoneHitRate,
        },
        rates
      ),
    [records, claude, callPrep, apollo, contacts, reveal, phoneHitRate, rates, ctx.maxPhoneReveals]
  );

  // Cost per contact uses the rate this install has actually observed, not a
  // hopeful assumption. Without history there is nothing honest to divide by.
  const contactsFound = ctx.observedContactRate !== null ? Math.round(records * ctx.observedContactRate) : null;
  const perContact = contactsFound !== null ? costPerOutcome(breakdown, contactsFound) : null;

  const presets: { label: string; n: number; note: string }[] = [
    { label: 'One batch', n: ctx.batchSize, note: 'the default run size' },
    { label: 'Queue now', n: ctx.queued, note: 'everything waiting' },
    { label: 'Daily cap', n: ctx.dailyCap, note: 'a full day at the limit' },
    { label: 'Monthly cap', n: ctx.monthlyCap, note: 'a full month at the limit' },
  ].filter((p) => p.n > 0);

  const rateField = (key: keyof CostRates, label: string, hint: string, step = 1) => (
    <label key={key} className="block">
      <Label hint={hint}>{label}</Label>
      <input
        type="number"
        min={0}
        step={step}
        value={rates[key]}
        onChange={(e) => setRates((r) => ({ ...r, [key]: Number(e.target.value) }))}
        className={`${controlClass} w-32`}
      />
    </label>
  );

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="This run" value={money(breakdown.totalUsd)} note={`${records.toLocaleString()} records`} />
        <Stat label="Per record" value={money(breakdown.perRecordUsd)} note="all engines combined" />
        <Stat
          label="Per contact found"
          value={perContact !== null ? money(perContact) : '—'}
          note={
            ctx.observedContactRate !== null
              ? `at your observed ${Math.round(ctx.observedContactRate * 100)}% hit rate`
              : 'no run history yet'
          }
        />
        <Stat
          label="Apollo credits"
          value={breakdown.totalCredits.toLocaleString()}
          note={apollo ? 'consumed by this run' : 'Apollo is off'}
        />
      </section>

      <Card>
        <CardHeader
          title="What you are costing"
          subtitle="Mirrors the enrichment policy — change these to model a different setup, then set them for real on the policy below"
        />
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <Label hint="records in the run">Volume</Label>
              <input
                type="number"
                min={0}
                value={records}
                onChange={(e) => setRecords(Math.max(0, Number(e.target.value)))}
                className={`${controlClass} w-32`}
              />
            </label>
            <div className="flex flex-wrap items-center gap-1.5 pb-1">
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  title={p.note}
                  onClick={() => setRecords(p.n)}
                  className={`rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors ${
                    records === p.n
                      ? 'border-brand bg-brand text-white'
                      : 'border-border-base text-muted hover:border-border-strong hover:text-foreground'
                  }`}
                >
                  {p.label} <span className="tabular-nums opacity-80">{p.n.toLocaleString()}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            {[
              { on: claude, set: setClaude, label: 'Claude resolution' },
              { on: callPrep, set: setCallPrep, label: 'Call-prep briefs', dim: !claude },
              { on: apollo, set: setApollo, label: 'Apollo contacts' },
              { on: reveal, set: setReveal, label: 'Direct dial reveal', dim: !apollo },
            ].map((t) => (
              <label
                key={t.label}
                className={`text-body flex items-center gap-2 text-[11px] ${t.dim ? 'opacity-40' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={t.on}
                  disabled={t.dim}
                  onChange={(e) => t.set(e.target.checked)}
                  className="border-border-base h-4 w-4 rounded"
                />
                {t.label}
              </label>
            ))}

            <label className="block">
              <Label>Contacts / account</Label>
              <input
                type="number"
                min={0}
                max={25}
                value={contacts}
                onChange={(e) => setContacts(Number(e.target.value))}
                className={`${controlClass} w-24`}
              />
            </label>

            {apollo && reveal ? (
              <label className="block">
                <Label hint="Apollo bills only when a number comes back">Reveal hit rate</Label>
                <select
                  value={phoneHitRate}
                  onChange={(e) => setPhoneHitRate(Number(e.target.value))}
                  className={`${controlClass} w-28`}
                >
                  {[0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1].map((r) => (
                    <option key={r} value={r}>
                      {Math.round(r * 100)}%
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Breakdown"
          action={<span className="text-foreground text-[13px] font-bold">{money(breakdown.totalUsd)}</span>}
        />
        <div className="divide-border-base divide-y">
          {breakdown.lines.map((l) => (
            <div key={l.label} className="flex flex-wrap items-baseline gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-foreground text-[12px] font-bold">{l.label}</p>
                <p className="text-muted text-[11px]">{l.detail}</p>
              </div>
              {l.credits ? <Badge tone="neutral">{l.credits.toLocaleString()} credits</Badge> : null}
              <span
                className={`w-24 shrink-0 text-right text-[12px] font-bold tabular-nums ${
                  l.usd === 0 ? 'text-success' : 'text-foreground'
                }`}
              >
                {l.usd === 0 ? 'free' : money(l.usd)}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Unit prices"
          subtitle="Provider pricing changes — these are estimates until you set your own. Apollo's 8 credits per mobile is documented; the rest depend on your plan."
          action={
            <Button size="sm" variant="ghost" onClick={() => setShowRates((v) => !v)}>
              {showRates ? 'Hide' : 'Edit prices'}
            </Button>
          }
        />
        {showRates ? (
          <div className="space-y-4 px-5 py-4">
            <div>
              <p className="text-muted mb-2 text-[10px] font-bold uppercase tracking-widest">Apollo</p>
              <div className="flex flex-wrap gap-3">
                {rateField('apolloCreditUsd', 'USD per credit', 'plan price ÷ credits', 0.001)}
                {rateField('apolloMatchCredits', 'Credits per contact', 'demographics + email')}
                {rateField('apolloPhoneCredits', 'Credits per mobile', 'Apollo documents 8')}
                {rateField('apolloSearchCredits', 'Credits per search', '0 on most plans')}
              </div>
            </div>
            <div>
              <p className="text-muted mb-2 text-[10px] font-bold uppercase tracking-widest">Anthropic</p>
              <div className="flex flex-wrap gap-3">
                {rateField('claudeInputUsdPerMTok', 'USD / M input', 'per million tokens', 0.5)}
                {rateField('claudeOutputUsdPerMTok', 'USD / M output', 'per million tokens', 0.5)}
                {rateField('claudeInputTokens', 'Input tokens', 'per record', 250)}
                {rateField('claudeOutputTokens', 'Output tokens', 'per record', 250)}
                {rateField('claudeSearchUsd', 'USD per web search', 'billed separately', 0.001)}
                {rateField('claudeSearchesPerRecord', 'Searches per record', 'capped at 6 in code')}
                {rateField('callPrepFactor', 'Call-prep multiplier', 'vs a resolution pass', 0.1)}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setRates(DEFAULT_RATES)}>
              Reset to estimates
            </Button>
          </div>
        ) : null}
      </Card>

      {ctx.observedRuns === 0 ? (
        <p className="text-subtle text-[11px]">
          No enrichment runs recorded yet, so cost-per-contact cannot be grounded in anything. Run one batch and this
          page starts using your real hit rate instead of an assumption.
        </p>
      ) : (
        <p className="text-subtle text-[11px]">
          Cost per contact uses the rate observed across {ctx.observedRuns} recorded run
          {ctx.observedRuns === 1 ? '' : 's'}. The dollar figures are estimates from the unit prices above; only your
          provider invoices are authoritative.
        </p>
      )}
    </div>
  );
}
