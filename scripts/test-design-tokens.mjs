/**
 * The design token layer holds, and nothing renders a colour behind its back.
 *
 *   node --no-warnings scripts/test-design-tokens.mjs
 *
 * Three separate things are asserted here, each of which has a failure mode that
 * looks like nothing at all until somebody notices the UI drifting.
 *
 * 1. NO RAW HEX IN COMPONENTS. The chrome used to carry five copies of #1c1c1c
 *    and two of #0c0c0c inline. Nothing was broken by that — it just meant the
 *    topbar and rail could not be restyled without finding every copy, and a
 *    sixth copy that was one digit off would have looked deliberate. The colours
 *    now live in `--sidebar-*` in globals.css. A raw hex creeping back into a
 *    component is the regression.
 *
 * 2. THE CHROME TOKENS ARE THEME-INDEPENDENT. The topbar and rail are dark in
 *    BOTH themes — that is a decision, not an oversight, and it is why these
 *    tokens sit in `:root` and are deliberately absent from `.dark`. Someone
 *    "fixing" that by adding a `.dark` override would silently make the chrome
 *    light-on-light in one theme. The test states the intent so the next reader
 *    sees it before changing it.
 *
 * 3. THE ProductOS ALIASES EXIST. Components copied from the ProductOS design
 *    skill (or its starter) reference THEIR token names — `--color-card`,
 *    `--color-muted-foreground`, `--color-ring` and so on. Without the aliases a
 *    pasted component renders unstyled in places and mis-styled in others, which
 *    reads as "the component is broken" rather than "the alias is missing".
 *
 *    `--color-muted` is checked NEGATIVELY, and that is the important one. In
 *    ProductOS `--muted` is a muted SURFACE whose text colour is
 *    `--muted-foreground`. Here `--muted` has always been the TEXT colour, and
 *    374 call sites across 62 files say `text-muted`. So the alias adds
 *    `--color-muted-foreground` and leaves `--color-muted` pointing at the local
 *    meaning. The cost is that `bg-muted` — perfectly legal in ProductOS —
 *    paints a text grey here. It appears zero times today, and this test keeps
 *    it that way rather than letting one appear and be debugged from scratch.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0,
  failed = 0;
const check = (n, c, d) => {
  if (c) {
    passed++;
    console.log(`  PASS ${n}`);
  } else {
    failed++;
    console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`);
  }
};

const css = readFileSync('src/app/globals.css', 'utf8');

/** Every file with `ext` under src/, so the walk does not have to be maintained by hand. */
function srcFiles(dir, ext = '.tsx') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p, ext));
    else if (entry.endsWith(ext)) out.push(p);
  }
  return out;
}

const files = srcFiles('src');

console.log('\nColour lives in tokens, not in components');

/*
  Tailwind's arbitrary-value syntax is the only way a raw colour reaches a
  component — `bg-[#0c0c0c]`, `text-[#8a8a8a]`. Matching the bracket form rather
  than any `#rrggbb` keeps the check on class names and off unrelated strings
  like an SVG fill or a copy deck.
*/
const HEX_UTILITY = /(?:bg|text|border|ring|fill|stroke|from|via|to|shadow|outline|decoration|divide|accent|caret)-\[#[0-9a-fA-F]{3,8}\]/g;
const offenders = [];
for (const f of files) {
  const hits = readFileSync(f, 'utf8').match(HEX_UTILITY);
  if (hits) offenders.push(`${f}: ${[...new Set(hits)].join(', ')}`);
}
check(
  `no raw hex colour utilities in any of the ${files.length} .tsx files`,
  offenders.length === 0,
  offenders.join(' | ')
);

console.log('\nThe application chrome is tokenised and theme-independent');

const CHROME = [
  'sidebar',
  'sidebar-border',
  'sidebar-foreground',
  'sidebar-heading',
  'sidebar-subtle',
  'sidebar-accent',
  'sidebar-accent-hover',
  'sidebar-accent-foreground',
];

/*
  Split on the `.dark` selector so each half can be searched independently. The
  chrome tokens must appear in the first half and NOT the second — that is the
  whole "dark in both themes" decision, expressed as a location.
*/
const darkAt = css.indexOf('.dark {');
check('globals.css still has a .dark block to compare against', darkAt > 0);
const rootHalf = css.slice(0, darkAt);
const darkHalf = css.slice(darkAt, css.indexOf('@theme'));

for (const t of CHROME) {
  check(`--${t} is defined once, in :root`, rootHalf.includes(`--${t}:`));
}
const leaked = CHROME.filter((t) => darkHalf.includes(`--${t}:`));
check(
  'no chrome token is re-declared in .dark — the chrome is dark in both themes',
  leaked.length === 0,
  leaked.length ? `${leaked.join(', ')} re-declared; the rail would change colour with the theme` : ''
);

for (const t of CHROME) {
  check(`--color-${t} is exposed to Tailwind`, css.includes(`--color-${t}: var(--${t})`));
}

console.log('\nProductOS token aliases are present, so copied components land styled');

const ALIASES = [
  'muted-foreground',
  'card',
  'card-foreground',
  'popover',
  'secondary',
  'accent',
  'accent-foreground',
  'border',
  'input',
  'ring',
  'primary',
  'primary-foreground',
  'destructive',
];
for (const a of ALIASES) {
  check(`--color-${a} is aliased`, new RegExp(`--color-${a}:\\s*var\\(`).test(css));
}

console.log('\nbg-muted stays out of the codebase');

/*
  Not a style preference — a correctness check. `--color-muted` is this app's
  TEXT grey, so `bg-muted` paints a background in a colour chosen to be read
  against one. Use `bg-surface-raised` (the local name) or `bg-accent` (the
  ProductOS alias, which points at the same value).
*/
const bgMuted = files.filter((f) => /\bbg-muted\b/.test(readFileSync(f, 'utf8')));
check(
  'no component uses bg-muted',
  bgMuted.length === 0,
  bgMuted.length
    ? `${bgMuted.join(', ')} — --muted is the TEXT colour here; use bg-surface-raised or bg-accent`
    : ''
);

console.log('\nThe className merge is conflict-aware');

/*
  A plain `parts.filter(Boolean).join(' ')` emits BOTH the component's class and
  the caller's override, leaving the winner to Tailwind's emission order rather
  than to the caller. It is not a visible bug today — the orders happen to
  agree — but it makes every `className` override contingent on the order of
  unrelated utilities elsewhere in the app. cn() resolves by utility group.
*/
const ui = readFileSync('src/components/ui/index.tsx', 'utf8');
check('components/ui imports cn()', /import \{ cn \} from '@\/lib\/cn'/.test(ui));
check(
  'components/ui no longer defines a naive local join',
  !/function cx\(/.test(ui),
  'a local cx() is back; className overrides stop being reliable'
);
const cn = readFileSync('src/lib/cn.ts', 'utf8');
check('cn() merges through tailwind-merge', /twMerge\(/.test(cn));

/*
  A tone and a className have to survive each other.

  Adopting cn() in this file left one `className ?? tones[tone]` behind, which is
  the opposite contract: it made ANY caller class replace the whole tone. Five
  call sites pass `className="ml-2"` and nothing else, so five badges lost their
  colour to a margin — including the inactive/quota-0 pair in HandoverByPerson
  that is, by its own comment, the only surface telling a rep those leads are
  going nowhere.

  Asserted structurally rather than by rendering: `??` between a className and a
  tone map is the defect, and it is cheap to keep out.
*/
/*
  Comments stripped, like test-silent-zero.mjs does for the same reason: the
  comment explaining the fix quotes the banned expression verbatim, so a naive
  search finds the prohibition and reports it as the violation. The first run of
  this assertion failed on the documentation of the thing it was guarding.
*/
const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check(
  'no primitive lets a className replace its tone',
  !/className \?\? tones?\[/.test(uiCode),
  'className ?? tones[...] is back — a caller passing a margin would drop the colour'
);
check('Badge applies its tone unconditionally', /badgeTone\[tone\],[\s]*className/.test(ui));
const badgeSites = files.filter((f) => /<Badge[^>]*className=/.test(readFileSync(f, 'utf8')));
check(
  'every Badge that takes a className still resolves a tone',
  badgeSites.length > 0,
  'expected the override call sites to still exist'
);

console.log('\nNo class name that Tailwind cannot emit');
/*
  Three of these shipped and never rendered.

  `py-4-raised/60` in EnrichPanel, `sm:w-40-raised` and `sm:w-56-raised` in
  CredentialForm — all three born in the first commit, all three dead. Tailwind
  emits nothing for them, so the enrichment panel had horizontal padding and no
  vertical padding, and two credential inputs never took their narrow width at
  `sm`. Nothing failed: a class that does not exist is silently no styling at all,
  which is the whole reason this needs a test rather than review.

  The shape is a spacing/size utility whose numeric scale is followed by another
  word — the fingerprint of a token rename that ran through class names it should
  not have touched (`surface-raised` leaving `-raised` behind). Colour prefixes are
  deliberately excluded: `bg-emerald-900` and `text-2xl` are the same shape and
  perfectly valid.
*/
const SIZE_PREFIX = 'p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|w|h|size|top|left|right|bottom|inset|basis|space-x|space-y';
const DEAD_UTILITY = new RegExp(String.raw`\b(?:${SIZE_PREFIX})-\d+(?:\.\d+)?-[a-z]`, 'g');
const dead = [];
for (const f of files) {
  const hits = readFileSync(f, 'utf8').match(DEAD_UTILITY);
  if (hits) dead.push(`${f}: ${[...new Set(hits)].join(', ')}`);
}
check('no spacing or size utility carries a trailing word', dead.length === 0, dead.join(' | '));

/*
  The same damage, other shape: an opacity modifier glued to a spacing utility.

  SupabaseNotConfigured carried `px-1 py-0.5/10` four times — the /10 from a
  neighbouring `bg-black/10` landed on the padding, and padding has no opacity, so
  the class died and those code spans lost their vertical padding. The trailing-word
  guard above did not see it because there is no trailing word.

  Only SPACING prefixes are checked: w-1/2, w-2/3 and basis fractions are real and
  in use, so size prefixes stay out of this one.
*/
const SPACING_ONLY = 'p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y';
const DEAD_OPACITY = new RegExp(String.raw`\b(?:${SPACING_ONLY})-\d+(?:\.\d+)?\/\d+`, 'g');
const deadOpacity = [];
for (const f of files) {
  const hits = readFileSync(f, 'utf8').match(DEAD_OPACITY);
  if (hits) deadOpacity.push(`${f}: ${[...new Set(hits)].join(', ')}`);
}
check('no spacing utility carries an opacity modifier', deadOpacity.length === 0, deadOpacity.join(' | '));

console.log('\nStatus colour has exactly one home');
/*
  ProductOS rule 5: every component that renders a status imports its colours from
  one module, so a tone cannot mean two things in two panels.

  It had already drifted twice here. EnrichPanel painted "good" on the -100/-800
  ramp while Badge used -50/-700, and inside components/ui itself Badge and
  StatusDot carried raw palette while ProgressBar and Toast — same file — expressed
  the same four tones as --success/--warning/--danger. Nothing was broken; the app
  simply had two vocabularies for one idea, and no way to notice.

  So the status ramp is banned everywhere except lib/status-colors.ts. Chart hues
  and one-off illustration colours are not status and are not covered by this.
*/
/*
  Two holes this check had, both found by sweeping by hand after the list emptied.

  It named eight hues and missed violet, indigo, teal and blue — so an indigo ICP
  pill and a blue link sat in SourceSearch and SourceFilterForm the whole time,
  reported clean.

  And it only ever read .tsx. The two largest colour maps in the codebase are .ts:
  lifecycle.ts's STATUS_COLORS and semantics.ts's BAND_COLORS/ARRIVAL_COLORS. A
  guard that cannot see the files most likely to hold a colour map reads well and
  does nothing.
*/
const STATUS_RAMP =
  /\b(?:bg|text|border)-(?:emerald|amber|rose|sky|green|red|yellow|orange|violet|indigo|teal|blue)-\d{2,3}\b/;

/*
  Three homes, not one, and deliberately.

  status-colors.ts owns tone — how a thing is doing. lifecycle.ts and semantics.ts
  own domain vocabularies: a lead's STATUS, its band, its arrival verdict. Those
  are categorical scales, they were single-source before any of this, and folding
  them into status-colors.ts would make one file that is really three plus a
  circular import between a vocabulary and the tones.

  The property the rule enforces is that a colour is defined once where its meaning
  lives — not that there is exactly one file. A fourth name here should feel
  expensive, and needs the same argument these three have.
*/
const VOCABULARIES = ['status-colors.ts', 'lifecycle.ts', 'semantics.ts'];
/*
  Comments stripped, for the third time in this file and the same reason each
  time: the comment that explains a banned pattern has to quote it. The Callout
  docblock says the fifth copy "had drifted to dark:bg-amber-950/30", and that
  sentence made components/ui report itself.
*/
const stripped = (f) =>
  readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
const scanned = [...files, ...srcFiles('src', '.ts')];
const strays = scanned
  .filter((f) => !VOCABULARIES.some((v) => f.endsWith(v)))
  .filter((f) => STATUS_RAMP.test(stripped(f)));
/*
  The list is empty, so the rule is just the rule.

  It started as a ratchet over 21 files, because converting them is a judgement
  per call site — which shade pair, text or surface, and whether the thing being
  coloured is a status at all. Three turned out not to be: the rail's footer green
  is chrome, a contact email is a link, and an ICP score is a measure. Those got
  their own names rather than a status tone.

  STATUS_HUE_DEBT is gone rather than left empty. An empty exemption list is an
  invitation to add one back; no list at all makes the next person put their
  colour where the others live.
*/
check('no component hardcodes a status hue', strays.length === 0, strays.join(', '));

console.log('\nThe lane palette is the one the validator passed');
/*
  Pinned values, because this palette was chosen by measurement and a plausible
  edit undoes that silently.

  The pair it replaced — sales/act_now bg-emerald-500 against sales/qualify
  bg-emerald-400 — measured normal-vision ΔE 7.7 against a floor of 15. Below the
  floor a reader with FULL colour vision cannot separate the two, so the dashboard
  drew its two most important lanes as the same bar twice and nothing in the code
  or the UI said so. It read as a tidy pair of greens.

  Route now carries the hue and stage carries a step within it: ΔE 17.1 light,
  17.2 dark, and the four route hues separate at 23.2. Re-derive with
  dataviz/scripts/validate_palette.js before changing any value here.

  Also asserted: the classes are literal strings. Tailwind resolves classes by
  scanning source text, so a composed `bg-${hue}-600` emits no CSS at all — the
  dead-utility failure mode this file already guards elsewhere.
*/
const LANE_EXPECTED = {
  "'sales/act_now'": "'bg-emerald-600'",
  "'sales/qualify'": "'bg-emerald-600/55'",
  "'marketing/nurture'": "'bg-amber-500 dark:bg-amber-600'",
  "'partner/hold'": "'bg-violet-500'",
  "'none/hold'": "'bg-zinc-400 dark:bg-zinc-500'",
  "'none/disqualify'": "'bg-zinc-400/50 dark:bg-zinc-500/50'",
};
const colors = readFileSync('src/lib/status-colors.ts', 'utf8');
const laneBlock = colors.slice(colors.indexOf('export const laneBar'));
const laneBody = laneBlock.slice(0, laneBlock.indexOf('};'));
for (const [lane, cls] of Object.entries(LANE_EXPECTED)) {
  check(`${lane} is ${cls}`, laneBody.includes(`${lane}: ${cls},`), 'validated value changed — re-run the validator');
}
check(
  'the two sales stages are no longer the same hue at adjacent steps',
  !laneBody.includes("'bg-emerald-500'") && !laneBody.includes("'bg-emerald-400'"),
  'emerald-500/emerald-400 is the ΔE 7.7 pair this replaced'
);
check(
  'no lane class is composed at runtime',
  !laneBody.includes('${'),
  'a template literal here emits no CSS — Tailwind scans source text'
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
