import type { PolicyField, Choice } from '@/components/settings/PolicyEditor';
import { BUSINESS_UNITS, BU_LABELS, PRIORITY_BANDS, RECORD_TYPES, VERTICALS, titleize } from '@/lib/semantics';

const asChoices = (values: readonly string[], label?: (v: string) => string): Choice[] =>
  values.map((v) => ({ value: v, label: label?.(v) ?? titleize(v) }));

/** Apollo's seniority vocabulary, most senior first. */
const SENIORITY_CHOICES: Choice[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'founder', label: 'Founder' },
  { value: 'c_suite', label: 'C-suite' },
  { value: 'partner', label: 'Partner' },
  { value: 'vp', label: 'VP' },
  { value: 'head', label: 'Head of' },
  { value: 'director', label: 'Director' },
  { value: 'manager', label: 'Manager' },
  { value: 'senior', label: 'Senior' },
  { value: 'entry', label: 'Entry' },
  { value: 'intern', label: 'Intern' },
];

/**
 * The enrichment policy as controls.
 *
 * Every hint answers the same question — what does this cost me, or what does
 * it stop me spending — because that is the only reason any of these knobs
 * exist. Enrichment is charged per record, so a parameter nobody understands
 * is a parameter nobody dares change.
 */
export const ENRICHMENT_FIELDS: PolicyField[] = [
  /* ---- Engines: what runs, and what each one is for --------------------- */
  {
    path: 'engines.claude',
    label: 'Claude',
    kind: 'toggle',
    group: 'Engines',
    hint: 'Identifies the account behind a record and writes the SDR brief. Costs tokens per record.',
  },
  {
    path: 'engines.apollo',
    label: 'Apollo',
    kind: 'toggle',
    group: 'Engines',
    hint: 'Finds verified decision-maker contacts. Costs one credit per account looked up.',
  },
  {
    path: 'engines.gleif',
    label: 'GLEIF',
    kind: 'toggle',
    group: 'Engines',
    hint: 'Resolves corporate parent/subsidiary structure. Keyless and free — little reason to turn it off.',
  },
  {
    path: 'generateCallPrep',
    label: 'Call-prep briefs',
    kind: 'toggle',
    group: 'Engines',
    hint: 'A second Claude pass per enriched record. The most expensive step — turn it off to keep account resolution without the briefs.',
  },

  /* ---- Eligibility: who is worth spending on --------------------------- */
  {
    path: 'bands',
    label: 'Priority bands',
    kind: 'multiselect',
    group: 'Who gets enriched',
    choices: asChoices(PRIORITY_BANDS, (v) => v),
    emptyLabel: 'nothing is eligible',
    hint: 'Only these bands are ever enriched. P1/P2 keeps spend on leads someone will actually work.',
    wide: true,
  },
  {
    path: 'recordTypes',
    label: 'Record types',
    kind: 'multiselect',
    group: 'Who gets enriched',
    choices: asChoices(RECORD_TYPES),
    emptyLabel: 'nothing is eligible',
    hint: 'News and signals rarely have an account worth resolving, so they are off by default.',
    wide: true,
  },
  {
    path: 'bus',
    label: 'Business units',
    kind: 'multiselect',
    group: 'Who gets enriched',
    choices: asChoices(BUSINESS_UNITS, (v) => BU_LABELS[v] ?? titleize(v)),
    emptyLabel: 'every business unit is eligible',
    hint: 'Restrict spend to the regions you are actively selling into.',
    wide: true,
  },
  {
    path: 'verticals',
    label: 'Verticals',
    kind: 'multiselect',
    group: 'Who gets enriched',
    choices: asChoices(VERTICALS),
    emptyLabel: 'every vertical is eligible',
    hint: 'Narrow to the sectors your ICP covers. Everything else stays unenriched until you widen this.',
    wide: true,
  },
  {
    path: 'minPriorityScore',
    label: 'Minimum priority score',
    kind: 'number',
    group: 'Who gets enriched',
    min: 0,
    max: 100,
    hint: '0–100. Applies on top of the bands above — a record must clear both.',
  },
  {
    path: 'minEstimatedValue',
    label: 'Minimum project value',
    kind: 'number',
    group: 'Who gets enriched',
    min: 0,
    hint: 'Records worth less are skipped — as are records with no value at all, since they cannot be shown to clear the bar. 0 disables it.',
  },
  {
    path: 'onlyMissingContact',
    label: 'Only records with no contact',
    kind: 'toggle',
    group: 'Who gets enriched',
    hint: 'The point of enrichment is a name to call. Turning this off re-enriches records that already have one.',
  },
  {
    path: 'maxEmailRevealsPerRecord',
    label: 'Email reveals per record',
    kind: 'number',
    group: 'Contacts',
    hint: 'Apollo search says an address exists; getting it is a separate call at one credit each. This is the real spend dial — contacts per account decides how many people are found, this decides how many become contactable. 0 turns revealing off, leaving contacts with a name and title and nothing to send to.',
  },
  {
    path: 'requireChannel',
    label: 'Require a validated phone or email',
    kind: 'toggle',
    group: 'Who gets enriched',
    hint: 'On, a lead stays queued until it has the channel its lane works through — right once contact details actually arrive. Turn it OFF while no verification tool is connected and the contact source returns no addresses: Apollo reports only that an email exists, and revealing it is a separate credited call. Left on in that state nothing is ever workable and the queue grows with no explanation.',
  },
  {
    path: 'requireCompany',
    label: 'Require a company name',
    kind: 'toggle',
    group: 'Who gets enriched',
    hint: 'Apollo resolves contacts from a company. Without one the credit is spent to return nothing.',
  },
  {
    path: 'reenrichAfterDays',
    label: 'Re-enrich after (days)',
    kind: 'number',
    group: 'Who gets enriched',
    min: 0,
    hint: 'A record enriched more recently than this is skipped. 0 means re-enrich anything, which is how budget disappears fastest.',
  },

  /* ---- Contacts: what Apollo is asked for ------------------------------ */
  {
    path: 'contactsPerAccount',
    label: 'Contacts per account',
    kind: 'number',
    group: 'Contacts',
    min: 1,
    max: 25,
    hint: 'More contacts per account means more credits per record. Apollo returns at most 10 per call.',
  },
  {
    path: 'contactSeniorities',
    label: 'Seniorities',
    kind: 'multiselect',
    group: 'Contacts',
    choices: SENIORITY_CHOICES,
    emptyLabel: 'Apollo returns whoever it has, at any level',
    hint: 'Narrower means fewer but more senior contacts for the same credit.',
    wide: true,
  },
  {
    path: 'fallbackTitles',
    label: 'Fallback job titles',
    kind: 'list',
    group: 'Contacts',
    hint: 'Comma-separated. Used only for sources whose enrichment profile names no titles of its own — a profile always wins.',
    wide: true,
  },

  /* ---- Spend rails ------------------------------------------------------ */
  {
    path: 'fillCommittee',
    label: 'Fill the buying committee',
    kind: 'toggle',
    group: 'Contacts',
    hint: 'One search rarely returns a whole committee. This goes back for each missing role — a narrow Apollo search per role, then Claude for what Apollo cannot find. More calls per account, and a list a BDR can actually work.',
    wide: true,
  },
  {
    path: 'committeeSize',
    label: 'List standard',
    kind: 'select',
    group: 'Contacts',
    choices: [
      { value: 'enterprise', label: 'Enterprise — 2 of each role (8)' },
      { value: 'mid_market', label: 'Mid-market — 1 of each role (4)' },
    ],
    hint: 'A list is complete by shape, not by count: eight site managers is not a complete list.',
  },
  {
    path: 'contactsPerRole',
    label: 'Contacts per missing role',
    kind: 'number',
    group: 'Contacts',
    min: 1,
    max: 10,
    hint: 'How many to request when going back for a role.',
  },
  {
    path: 'revealPhoneNumbers',
    label: 'Reveal direct dials',
    kind: 'toggle',
    group: 'Contacts',
    hint: 'Apollo search never returns phone numbers. Turning this on asks for verified direct dials and mobiles — 8 credits each against 1 for a work email, delivered asynchronously to the webhook below.',
    wide: true,
  },
  {
    path: 'phoneWebhookUrl',
    label: 'Phone webhook URL',
    kind: 'list',
    group: 'Contacts',
    hint: 'Public HTTPS only — Apollo cannot reach localhost. Use https://your-app/api/webhooks/apollo/phone?token=YOUR_CRON_SECRET',
    wide: true,
  },
  {
    path: 'maxPhoneRevealsPerRun',
    label: 'Max reveals per run',
    kind: 'number',
    group: 'Contacts',
    min: 0,
    hint: 'A spend rail, not a batch size: 10 reveals is up to 80 Apollo credits.',
  },
  {
    path: 'batchSize',
    label: 'Default batch size',
    kind: 'number',
    group: 'Spend limits',
    min: 1,
    hint: 'Records per run when nobody names a number.',
  },
  {
    path: 'maxBatchSize',
    label: 'Maximum batch size',
    kind: 'number',
    group: 'Spend limits',
    min: 1,
    hint: 'Hard ceiling. A run can ask for less but never more, whatever the caller sends.',
  },
  {
    path: 'concurrency',
    label: 'Concurrency',
    kind: 'number',
    group: 'Spend limits',
    min: 1,
    max: 10,
    hint: 'Records enriched in parallel. Higher is faster but more likely to hit provider rate limits.',
  },
  {
    path: 'dailyCap',
    label: 'Daily cap',
    kind: 'number',
    group: 'Spend limits',
    min: 0,
    hint: 'Records per rolling 24h, counted from enriched_at so it survives restarts. 0 disables it.',
  },
  {
    path: 'monthlyCap',
    label: 'Monthly cap',
    kind: 'number',
    group: 'Spend limits',
    min: 0,
    hint: 'Records per rolling 30 days. Applied alongside the daily cap — whichever is tighter wins. 0 disables it.',
  },
  {
    path: 'apolloBatchSize',
    label: 'Apollo export batch',
    kind: 'number',
    group: 'Spend limits',
    min: 1,
    hint: 'Contacts pushed per daily export run. Apollo caps a batch at 100.',
  },
];
