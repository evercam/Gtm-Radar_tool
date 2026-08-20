/**
 * Canonical status colours. The one place a tone becomes a colour.
 *
 * ProductOS rule: every component that renders a status indicator imports from
 * here, so a tone cannot mean two different things in two different panels. That
 * had already happened twice in this codebase — EnrichPanel painted "good" on the
 * -100/-800 ramp while Badge used -50/-700, and Badge itself sat next to a
 * ProgressBar expressing the same four tones as `--success`/`--warning`/`--danger`
 * tokens. Same file, two vocabularies.
 *
 * WHY THE TINTS ARE STILL RAW PALETTE, NOT TOKENS
 *
 * The tempting move is `bg-success/10 text-success border-success/30`, the way
 * `brand` is written below — one definition, both themes, no light/dark pair. It
 * is wrong for text. `--success` is #34d399, a bright mint chosen to read against
 * a dark surface; as TEXT on the light theme's #ffffff card it lands around 1.9:1,
 * far under the 4.5:1 a small 10px uppercase label needs. The -700/-300 pairs
 * below are picked per theme precisely so the label stays legible in both.
 *
 * So the tokens own SURFACES and fills, where the tint is decorative and contrast
 * is not at stake, and these pairs own TEXT. `brand` is the exception that proves
 * it: --brand is #c1171e, dark enough to be readable on white, so it can be
 * written once.
 */

/** Badge: bordered pill, 10px uppercase. Text-bearing, so light/dark aware. */
export const badgeTone = {
  neutral: 'bg-surface-raised text-body border-border-base',
  success:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-900',
  warning:
    'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-900',
  danger: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-900',
  info: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-900',
  brand: 'bg-brand/10 text-brand border-brand/30',
} as const;

export type BadgeTone = keyof typeof badgeTone;

/**
 * Provenance is NOT a status.
 *
 * `ORIGIN_BADGE` used to paint apollo emerald, claude violet and gleif blue —
 * emerald being the exact hue that means "success" three lines above. "This field
 * came from Apollo" is not good news; it is a fact about where a value was
 * sourced. Colouring it green spent the one signal that means "good" on something
 * that carries no judgement at all, and a reader scanning a column of applied
 * fields for problems got a wall of green.
 *
 * ProductOS resolves this the same way for everything that is not a live state —
 * archived, planned, cancelled, backlog are all neutral there. So origins are
 * neutral and told apart by their LABEL, in mono, which is also how the app
 * already renders every other identifier.
 */
export const provenanceChip = 'bg-surface-raised text-muted border-border-base font-mono';

/** Small solid indicator dots. Fill only — no text, so tokens are safe here. */
export const statusDot = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger',
  idle: 'bg-border-strong',
} as const;

export type StatusDotTone = keyof typeof statusDot;

/** Progress fills. Decorative surface, tokens. */
export const progressTone = {
  brand: 'bg-brand',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-border-strong',
} as const;

export type ProgressTone = keyof typeof progressTone;

/** Toast left-edge rule. Decorative, tokens. */
export const toastTone = {
  success: 'border-l-success',
  error: 'border-l-danger',
  info: 'border-l-info',
} as const;

export type ToastToneName = keyof typeof toastTone;

/**
 * Status as TEXT — a number or a word that is itself the signal.
 *
 * The app had two reds for one meaning: `text-red-600 dark:text-red-400` in six
 * places and `text-rose-600 dark:text-rose-400` in six others, chosen by whoever
 * typed them. Rose wins because Badge's danger tone is already rose, so the pill
 * and the figure beside it now agree.
 *
 * The -600/-400 split is the same contrast reasoning as badgeTone: -600 to carry
 * against a light card, -400 to carry against a dark one.
 */
export const statusText = {
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-rose-600 dark:text-rose-400',
  info: 'text-sky-600 dark:text-sky-400',
} as const;

export type StatusTextTone = keyof typeof statusText;

/**
 * Full-width callout — the "this is broken / not configured" banner.
 *
 * Border, surface and text move together, so they are one recipe rather than
 * three classes a caller has to remember to keep in step.
 */
export const calloutTone = {
  warning:
    'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
  danger: 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300',
} as const;

/**
 * The heading inside a callout, one shade stronger than its body.
 *
 * Kept as its own entry rather than a `font-semibold` on the body colour: at
 * these tints, weight alone does not separate a title from the paragraph under
 * it, and MigrationRequired had already reached for -900/-200 by hand to get
 * there. Now it is the same reach everywhere.
 */
export const calloutTitleTone = {
  warning: 'text-amber-900 dark:text-amber-200',
  danger: 'text-rose-900 dark:text-rose-200',
} as const;

/** Inline code inside a callout — a tint of its own surface, not a grey. */
export const calloutCodeTone = {
  warning: 'bg-amber-100 dark:bg-amber-900/50',
  danger: 'bg-rose-100 dark:bg-rose-900/50',
} as const;

export type CalloutTone = keyof typeof calloutTone;

/**
 * A destructive affordance that only colours on hover.
 *
 * "remove" links sit at rest in muted grey and turn red under the cursor, so the
 * colour is an answer to "what will this do", not a permanent alarm in a list of
 * files. Its own entry because statusText carries no hover: prefix, and writing
 * one at the call site is how the red/rose split happened in the first place.
 */
export const dangerHoverText = 'hover:text-rose-600 dark:hover:text-rose-400';

/**
 * A "go" button that is green rather than brand.
 *
 * Two bulk actions — Apply routing, Run enrichment — were hand-rolled <button>s
 * in emerald-600, bypassing the Button primitive and therefore its focus ring and
 * its disabled handling. Routing them through Button needed a variant, and this
 * preserves exactly the green they already had.
 *
 * Worth a decision later, and deliberately not made here: the app's primary
 * action colour is --brand, and ProductOS reads emerald as "succeeded", not "go".
 * These two may well belong in brand like every other primary button. That is a
 * visible change to the two loudest controls in the tool, so it is the owner's
 * call, not a side effect of a refactor.
 */
export const successAction = 'bg-emerald-600 text-white hover:bg-emerald-500 font-bold';

/** A table row whose record failed. A tint, not a text colour — the whole row is the subject. */
export const rowTone = {
  danger: 'bg-rose-50/50 dark:bg-rose-950/20',
} as const;
