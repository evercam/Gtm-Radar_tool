/**
 * The lead lifecycle.
 *
 * One record moves through a single ordered path from raw ingestion to a sales
 * outcome. Every stage answers "what has been spent on this, and what is the
 * next action":
 *
 *   RAW                 ingested, nothing spent
 *   PENDING_ENRICHMENT  selected by the prioritisation rules — queued
 *   ENRICHING           a worker holds it
 *   ENRICHED            account resolved and the required channel validated
 *   PREPARED            call-prep brief generated
 *   ASSIGNED            an owner holds it
 *   CONTACTED           the owner has reached out
 *   CONVERTED / LOST    terminal
 *
 * This replaces `processing_status`, whose vocabulary grew ad hoc alongside the
 * adapters (`ingested`, `normalized`, `scored`, `routed`, `qualified`…) and
 * mixed pipeline mechanics with sales progress. That column is backfilled into
 * `status` by the migration and kept read-only for one release; nothing new
 * should write to it.
 *
 * Pure data and pure functions, like lib/routing and lib/priority — the same
 * definitions drive the DB check constraint, the queue, and the UI.
 */

export const LEAD_STATUSES = [
  'RAW',
  'PENDING_ENRICHMENT',
  'ENRICHING',
  'ENRICHED',
  'PREPARED',
  'ASSIGNED',
  'CONTACTED',
  'CONVERTED',
  'LOST',
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const STATUS_LABELS: Record<LeadStatus, string> = {
  RAW: 'Raw',
  PENDING_ENRICHMENT: 'Queued',
  ENRICHING: 'Enriching',
  ENRICHED: 'Enriched',
  PREPARED: 'Prepared',
  ASSIGNED: 'Assigned',
  CONTACTED: 'Contacted',
  CONVERTED: 'Converted',
  LOST: 'Lost',
};

export const STATUS_DESCRIPTIONS: Record<LeadStatus, string> = {
  RAW: 'Ingested, not yet selected for enrichment',
  PENDING_ENRICHMENT: 'Selected by the prioritisation rules, waiting on a worker',
  ENRICHING: 'A worker is enriching this record now',
  ENRICHED: 'Account resolved and the required contact channel validated',
  PREPARED: 'Call-prep brief generated — ready for a seller',
  ASSIGNED: 'An owner holds this lead',
  CONTACTED: 'The owner has reached out',
  CONVERTED: 'Became an opportunity',
  LOST: 'Disqualified or lost',
};

export const STATUS_COLORS: Record<LeadStatus, string> = {
  RAW: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  PENDING_ENRICHMENT: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  ENRICHING: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
  ENRICHED: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
  PREPARED: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
  ASSIGNED: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  CONTACTED: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  CONVERTED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  LOST: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
};

/** Statuses no longer moving — excluded from every queue. */
export const TERMINAL_STATUSES: LeadStatus[] = ['CONVERTED', 'LOST'];

/**
 * The journey, as this tool can actually observe it.
 *
 * Deliberately not the same list as `LEAD_STATUSES`, for two reasons.
 *
 * CONTACTED and CONVERTED are not observable here. Nothing in the app ever
 * transitions a lead into them — the seller works in Apollo, so the call and
 * the deal happen somewhere this database never hears about. Reporting them as
 * journey stages meant two rows pinned at 0 forever, which reads as "nobody
 * has contacted anyone" when the truth is "we cannot see it from here".
 *
 * EXPORTED is observable and was missing. The handover to Apollo is where a
 * lead's life in this tool ends: `apollo_exported_at` archives it out of the
 * queue, off the stock count, and out of enrichment for good. That is the real
 * last stage, and it was the one stage the funnel did not show.
 *
 * The two lists stay separate on purpose: `status` drives the queue and the DB
 * check constraint, this drives reporting. Retiring CONTACTED and CONVERTED
 * from the vocabulary itself would need a migration and would throw away the
 * column any future CRM write-back would land in.
 */
export const JOURNEY_STAGES = [
  'RAW',
  'PENDING_ENRICHMENT',
  'ENRICHING',
  'ENRICHED',
  'PREPARED',
  'ASSIGNED',
  'EXPORTED',
] as const;

export type JourneyStage = (typeof JOURNEY_STAGES)[number];

export const JOURNEY_STAGE_LABELS: Record<JourneyStage | 'LOST', string> = {
  ...STATUS_LABELS,
  EXPORTED: 'Exported',
};

export const JOURNEY_STAGE_DESCRIPTIONS: Record<JourneyStage | 'LOST', string> = {
  ...STATUS_DESCRIPTIONS,
  EXPORTED: 'Sent to Apollo and archived — the seller works it there',
};

export const JOURNEY_STAGE_COLORS: Record<JourneyStage | 'LOST', string> = {
  ...STATUS_COLORS,
  EXPORTED: STATUS_COLORS.CONVERTED,
};

/**
 * Where a status sits on the journey.
 *
 * CONTACTED and CONVERTED fold back to ASSIGNED: all three mean the same
 * observable thing here — a seller holds this lead. A record only advances past
 * ASSIGNED by actually being exported, which is a timestamp, not a status.
 */
export const STATUS_JOURNEY_STAGE: Record<LeadStatus, JourneyStage | 'LOST'> = {
  RAW: 'RAW',
  PENDING_ENRICHMENT: 'PENDING_ENRICHMENT',
  ENRICHING: 'ENRICHING',
  ENRICHED: 'ENRICHED',
  PREPARED: 'PREPARED',
  ASSIGNED: 'ASSIGNED',
  CONTACTED: 'ASSIGNED',
  CONVERTED: 'ASSIGNED',
  LOST: 'LOST',
};

/**
 * Allowed transitions. The pipeline is mostly linear, but a record can be lost
 * from any working stage, re-queued after a failed enrichment, and re-enriched
 * once stale — so this is a graph, not a straight line.
 */
export const ALLOWED_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  RAW: ['PENDING_ENRICHMENT', 'LOST'],
  // back to RAW when a batch is cancelled before it starts
  PENDING_ENRICHMENT: ['ENRICHING', 'RAW', 'LOST'],
  // back to PENDING_ENRICHMENT when a worker fails and the record is retried
  ENRICHING: ['ENRICHED', 'PENDING_ENRICHMENT', 'LOST'],
  // ENRICHED may skip PREPARED when call-prep is disabled or Claude is off
  ENRICHED: ['PREPARED', 'ASSIGNED', 'PENDING_ENRICHMENT', 'LOST'],
  PREPARED: ['ASSIGNED', 'PENDING_ENRICHMENT', 'LOST'],
  ASSIGNED: ['CONTACTED', 'PREPARED', 'CONVERTED', 'LOST'],
  CONTACTED: ['CONVERTED', 'LOST', 'ASSIGNED'],
  // terminal, but a conversion can be reopened if it falls through
  CONVERTED: ['LOST'],
  LOST: ['RAW'],
};

export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === 'string' && (LEAD_STATUSES as readonly string[]).includes(value);
}

/**
 * Maps the retired `processing_status` vocabulary onto the lifecycle. Used by
 * the migration's backfill and by any row written before the migration.
 *
 * The old column conflated two axes: `scored` / `routed` describe pipeline
 * mechanics that say nothing about enrichment, so they map to RAW — the record
 * genuinely has had nothing spent on it. `duplicate` and `failed` map to LOST
 * because neither will ever be worked.
 */
export const PROCESSING_STATUS_MAP: Record<string, LeadStatus> = {
  ingested: 'RAW',
  normalized: 'RAW',
  scored: 'RAW',
  routed: 'RAW',
  enriching: 'ENRICHING',
  enriched: 'ENRICHED',
  qualified: 'ASSIGNED',
  failed: 'LOST',
  duplicate: 'LOST',
};

export function statusFromProcessingStatus(value: string | null | undefined): LeadStatus {
  return PROCESSING_STATUS_MAP[value ?? ''] ?? 'RAW';
}

/** The timestamp column stamped when a record enters each status. */
export const STATUS_TIMESTAMP_COLUMN: Partial<Record<LeadStatus, string>> = {
  PENDING_ENRICHMENT: 'queued_at',
  ENRICHING: 'enrichment_started_at',
  ENRICHED: 'enriched_at',
  PREPARED: 'prepared_at',
  ASSIGNED: 'owner_assigned_at',
  CONTACTED: 'contacted_at',
  CONVERTED: 'converted_at',
  LOST: 'lost_at',
};

/**
 * The contact channel a lead must have before it can leave enrichment.
 *
 * Sales is a phone motion and marketing is an email motion, so a record
 * missing the channel its lane works through stays queued rather than reaching
 * someone who cannot act on it. Having both is better, but it is not the bar:
 * requiring both of the sales lanes held 3,383 leads behind a second channel
 * nobody needed in order to make the call.
 *
 * `any` exists for lanes worked either way — it asks for one usable channel
 * rather than a specific one.
 */
export type ContactChannel = 'phone' | 'email' | 'both' | 'any' | 'none';

/** What each lane needs, when nobody has said otherwise. */
export const DEFAULT_CHANNEL_RULES: Record<string, ContactChannel> = {
  act_now: 'phone',
  qualify: 'phone',
  nurture: 'email',
};

/**
 * Which channel a lane needs before a lead can leave enrichment.
 *
 * Configurable rather than fixed: this is the narrowest gate in the pipeline,
 * and the right answer depends on how a team actually works and on what the
 * data can supply. Demanding a phone is correct for a calling motion and
 * catastrophic when the database holds two phone numbers — so it is a setting,
 * not a constant.
 */
export function requiredChannel(
  stage: string | null | undefined,
  rules: Record<string, ContactChannel> = DEFAULT_CHANNEL_RULES
): ContactChannel {
  if (!stage) return 'none';
  return rules[stage] ?? 'none';
}

export interface ChannelReadiness {
  channel: ContactChannel;
  satisfied: boolean;
  missing: string[];
}

/** Whether a record carries the validated channel its lane requires. */
export function channelReadiness(record: {
  stage?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  phone_verified?: boolean | null;
  email_verified?: boolean | null;
}): ChannelReadiness {
  const channel = requiredChannel(record.stage);
  const hasPhone = Boolean(record.contact_phone);
  const hasEmail = Boolean(record.contact_email);
  const missing: string[] = [];

  if (channel === 'any') {
    // One usable channel is the whole requirement here.
    return hasPhone || hasEmail
      ? { channel, satisfied: true, missing: [] }
      : { channel, satisfied: false, missing: ['phone or email'] };
  }

  if (channel === 'phone' || channel === 'both') {
    if (!hasPhone) missing.push('phone');
  }
  if (channel === 'email' || channel === 'both') {
    if (!hasEmail) missing.push('email');
  }

  return { channel, satisfied: missing.length === 0, missing };
}
