/**
 * How well-evidenced a lead is — as distinct from how valuable it would be.
 *
 * `priority_score` answers "is this worth winning": value, capacity, ICP fit, key
 * account. It says nothing about whether we actually KNOW anything. A P1 built
 * from a single news headline with no dates, no phase and an inferred contact is a
 * guess wearing a high score, and it outranks a P3 backed by a permit filing, a
 * construction start date and a verified switchboard number.
 *
 * A rep cannot tell those apart on the current record, so they spend the same
 * preparation on both and discover the difference on the call. This scores the
 * evidence itself, so the two can be read side by side: strong-and-valuable is the
 * call to make today, weak-and-valuable is the one to research first.
 *
 * Pure — no I/O — so the weights are testable and the dashboard, the export and
 * the spreadsheet all grade a record the same way.
 */

import { arrivalFor, type ArrivalBasis, type ArrivalInput } from '@/lib/arrival';
import { DEFAULT_PRIORITY_CONFIG, type PriorityConfig } from '@/lib/priority';

export type SignalBand = 'strong' | 'moderate' | 'weak' | 'none';

export interface SignalComponent {
  key: string;
  /** 0..1 — how much of this component's evidence is present. */
  strength: number;
  weight: number;
  /** What was actually found, in words a rep can act on. */
  note: string;
}

export interface SignalAssessment {
  /** 0..100, weighted. */
  score: number;
  band: SignalBand;
  components: SignalComponent[];
  /** The component holding the score down most — what to go and find. */
  weakest: SignalComponent | null;
  /** One line, safe to render. */
  summary: string;
}

/**
 * Band cut-offs.
 *
 * `none` is its own band rather than the bottom of `weak`, because a record with
 * no evidence at all is a different instruction: weak means verify before calling,
 * none means there is nothing here yet to verify.
 */
export const SIGNAL_BANDS = { strong: 70, moderate: 45, weak: 20 } as const;

/*
  Weights.

  Timing evidence dominates because it is the one thing that decides whether a
  lead is callable at all — everything else describes a project we may or may not
  be able to reach at the right moment. Corroboration is next: a fact two sources
  agree on is a different class of fact from one a model inferred.
*/
const WEIGHTS = {
  timing: 32,
  corroboration: 22,
  specificity: 18,
  reachability: 16,
  recency: 12,
} as const;

/**
 * The evidence ladder already encoded in `ArrivalBasis`.
 *
 * A construction start date is the strongest thing this pipeline can hold: it is
 * the date the install window opens. A completion date is weaker because it is
 * often a refurbishment or a planning aspiration. `phase_only` means a curated
 * phase with no date — real, but it cannot be timed. `none` is nothing.
 */
const BASIS_STRENGTH: Record<ArrivalBasis, number> = {
  construction_start: 1,
  completion: 0.72,
  announced: 0.5,
  phase_only: 0.32,
  none: 0,
};

export interface SignalInput extends ArrivalInput {
  /** Where each field came from. `{ source: 'sdr_brief' }` marks a model finding. */
  field_provenance?: Record<string, unknown> | null;
  estimated_value?: number | null;
  capacity_mw?: number | null;
  square_footage?: number | null;
  address_line1?: string | null;
  city?: string | null;
  project_url?: string | null;
  description?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  email_verified?: boolean | null;
  phone_verified?: boolean | null;
  additional_contacts?: unknown;
  trigger_event?: string | null;
  source_completeness_score?: number | null;
}

const has = (v: unknown): boolean => v !== null && v !== undefined && String(v).trim() !== '';

/**
 * Fields whose provenance says a model supplied them.
 *
 * A schedule the brief found by reading a news article is genuinely useful — it is
 * why that step exists — but it is a weaker witness than a permit filing, and the
 * two are indistinguishable once written to the same column. Provenance is the only
 * thing that still tells them apart, so it is read here rather than trusted away.
 */
function inferredFields(provenance: Record<string, unknown> | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!provenance) return out;
  for (const [field, meta] of Object.entries(provenance)) {
    const source = (meta as { source?: unknown } | null)?.source;
    if (typeof source === 'string' && /brief|claude|model|inferred/i.test(source)) out.add(field);
  }
  return out;
}

const monthsSince = (iso: string | null | undefined, now: number): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (now - t) / (30.44 * 86_400_000);
};

/**
 * Grade the evidence on one record.
 *
 * Every component reports its own note, so the score is never a bare number — the
 * point of this is to say WHAT is missing, because that is the actionable part.
 */
export function assessSignal(
  record: SignalInput,
  config: PriorityConfig = DEFAULT_PRIORITY_CONFIG,
  now: number = Date.now()
): SignalAssessment {
  const arrival = arrivalFor(record, config, now);
  const inferred = inferredFields(record.field_provenance);

  /* ---- timing: can this be placed in time, and on what authority ---- */
  let timing = BASIS_STRENGTH[arrival.basis];
  const timingInferred =
    inferred.has('construction_start_date') || inferred.has('estimated_completion_date') || inferred.has('current_phase');
  /*
    A model-sourced schedule is discounted rather than ignored. It moved the record
    out of `unknown`, which is worth real credit — but it should not read as
    equal to a date that arrived from a permit filing.
  */
  if (timingInferred && timing > 0) timing *= 0.7;
  const timingNote =
    arrival.basis === 'none'
      ? 'No phase and no dates — this lead cannot be placed in time at all.'
      : `${arrival.basis.replace('_', ' ')}${timingInferred ? ', found by the brief rather than a source feed' : ''}.`;

  /* ---- corroboration: how many independent facts back this up ---- */
  const curatedFacts = ['current_phase', 'construction_start_date', 'estimated_completion_date', 'announced_date', 'bid_date']
    .filter((f) => has((record as unknown as Record<string, unknown>)[f]) && !inferred.has(f)).length;
  const corroboration = Math.min(1, curatedFacts / 3);
  const corroborationNote =
    curatedFacts === 0
      ? 'No dated fact from a source feed — nothing independent to check against.'
      : `${curatedFacts} dated fact${curatedFacts === 1 ? '' : 's'} from a source feed.`;

  /* ---- specificity: is this a real, locatable project or a headline ---- */
  const concrete = [
    has(record.estimated_value),
    has(record.capacity_mw) || has(record.square_footage),
    has(record.address_line1) || has(record.city),
    has(record.project_url),
    has(record.description),
  ].filter(Boolean).length;
  const specificity = concrete / 5;
  const specificityNote =
    concrete <= 1
      ? 'Little more than a name — no size, location or source page.'
      : `${concrete} of 5 concrete details (size, location, value, source page, description).`;

  /* ---- reachability: is there a person, and has the channel been checked ---- */
  const committee = Array.isArray(record.additional_contacts) ? record.additional_contacts.length : 0;
  let reachability = 0;
  if (has(record.contact_email) || has(record.contact_phone) || committee > 0) reachability = 0.55;
  // Verified beats present. An MX-checked address is not much, but a checked one
  // still outranks one nobody has tested.
  if (record.email_verified === true || record.phone_verified === true) reachability = 0.85;
  if (record.email_verified === true && record.phone_verified === true) reachability = 1;
  const reachabilityNote =
    reachability === 0
      ? 'Nobody to call — no email, no phone, no committee.'
      : reachability < 0.85
        ? `Contactable${committee ? ` (${committee} on the committee)` : ''}, but no channel has been verified.`
        : 'A verified channel exists.';

  /* ---- recency: how stale is the newest thing we know ---- */
  const freshest = Math.min(
    ...[monthsSince(record.announced_date, now), monthsSince(record.bid_date, now)]
      .filter((m): m is number => m !== null && m >= 0)
      .concat([Number.POSITIVE_INFINITY])
  );
  let recency = 0;
  if (Number.isFinite(freshest)) recency = freshest <= 3 ? 1 : freshest <= 12 ? 0.6 : freshest <= 24 ? 0.3 : 0.1;
  // A named trigger event is itself a recent signal, whatever the dates say.
  if (has(record.trigger_event)) recency = Math.max(recency, 0.7);
  const recencyNote = !Number.isFinite(freshest)
    ? has(record.trigger_event)
      ? 'A trigger event is named, but nothing is dated.'
      : 'Nothing dates this lead — it could be from any time.'
    : `Newest dated signal is ${Math.round(freshest)} month${Math.round(freshest) === 1 ? '' : 's'} old.`;

  const components: SignalComponent[] = [
    { key: 'timing', strength: timing, weight: WEIGHTS.timing, note: timingNote },
    { key: 'corroboration', strength: corroboration, weight: WEIGHTS.corroboration, note: corroborationNote },
    { key: 'specificity', strength: specificity, weight: WEIGHTS.specificity, note: specificityNote },
    { key: 'reachability', strength: reachability, weight: WEIGHTS.reachability, note: reachabilityNote },
    { key: 'recency', strength: recency, weight: WEIGHTS.recency, note: recencyNote },
  ];

  const totalWeight = components.reduce((n, c) => n + c.weight, 0);
  const score = Math.round(components.reduce((n, c) => n + c.strength * c.weight, 0) / (totalWeight / 100));

  const band: SignalBand =
    score >= SIGNAL_BANDS.strong
      ? 'strong'
      : score >= SIGNAL_BANDS.moderate
        ? 'moderate'
        : score >= SIGNAL_BANDS.weak
          ? 'weak'
          : 'none';

  /*
    The weakest component by how much weight it is LEAVING on the table, not by raw
    strength. A component worth 12 points that scores zero matters less than one
    worth 32 scoring a third, and telling somebody to go and fix the small one
    would be advice that cannot move the number.
  */
  const weakest = [...components].sort((a, b) => (1 - b.strength) * b.weight - (1 - a.strength) * a.weight)[0] ?? null;

  const summary =
    band === 'none'
      ? 'No usable signal — this needs research before anyone calls it.'
      : band === 'strong'
        ? `Well evidenced (${score}). ${arrival.summary}`
        : `${band === 'moderate' ? 'Partly' : 'Thinly'} evidenced (${score}). Weakest: ${weakest?.note ?? '—'}`;

  return { score, band, components, weakest, summary };
}

/** Sort key: best-evidenced first. */
export const SIGNAL_BAND_ORDER: Record<SignalBand, number> = { strong: 0, moderate: 1, weak: 2, none: 3 };
