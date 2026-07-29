import type { PolicyField, Choice } from '@/components/settings/PolicyEditor';
import { ICP_LABELS, VERTICALS, titleize } from '@/lib/semantics';

/**
 * The scoring parameters worth a real input. The phase-timing table and the
 * per-record-type fallbacks stay in the JSON pane — they are lists, not knobs.
 */
const SCORING_BASE: PolicyField[] = [
  {
    path: 'weights.timing',
    label: 'Timing',
    kind: 'number',
    group: 'Component weights',
    min: 0,
    max: 100,
    hint: 'How close the project is to breaking ground',
  },
  {
    path: 'weights.scale',
    label: 'Scale',
    kind: 'number',
    group: 'Component weights',
    min: 0,
    max: 100,
    hint: 'Deal size — value or MW',
  },
  { path: 'weights.icpFit', label: 'ICP fit', kind: 'number', group: 'Component weights', min: 0, max: 100 },
  {
    path: 'weights.contact',
    label: 'Contact',
    kind: 'number',
    group: 'Component weights',
    min: 0,
    max: 100,
    hint: 'Actionable today',
  },
  { path: 'weights.keyAccount', label: 'Key account', kind: 'number', group: 'Component weights', min: 0, max: 100 },
  { path: 'weights.freshness', label: 'Freshness', kind: 'number', group: 'Component weights', min: 0, max: 100 },
  {
    path: 'bands.P1',
    label: 'P1 — act now',
    kind: 'number',
    group: 'Band thresholds',
    min: 0,
    max: 100,
    hint: 'Score at or above this is P1',
  },
  { path: 'bands.P2', label: 'P2 — this week', kind: 'number', group: 'Band thresholds', min: 0, max: 100 },
  {
    path: 'bands.P3',
    label: 'P3 — nurture',
    kind: 'number',
    group: 'Band thresholds',
    min: 0,
    max: 100,
    hint: 'Below this is P4 (backlog)',
  },
  {
    path: 'valueSaturation',
    label: 'Value saturation',
    kind: 'number',
    group: 'Saturation & decay',
    min: 1,
    step: 1_000_000,
    hint: 'Project value that scores full marks',
  },
  {
    path: 'capacitySaturation_MW',
    label: 'Capacity saturation (MW)',
    kind: 'number',
    group: 'Saturation & decay',
    min: 1,
    hint: 'For energy assets with no value',
  },
  {
    path: 'freshnessWindowDays',
    label: 'Freshness window (days)',
    kind: 'number',
    group: 'Saturation & decay',
    min: 1,
    hint: 'Age at which freshness hits zero',
  },
  {
    path: 'deadPhaseCap',
    label: 'Dead-phase cap',
    kind: 'number',
    group: 'Saturation & decay',
    min: 0,
    max: 100,
    hint: 'Ceiling for complete/cancelled records',
  },
];

/** Values present in the data, so a list can only be built from things that exist. */
export interface ScoringFacets {
  icp: string[];
  vertical: string[];
}

const choices = (known: readonly string[], present: string[], label?: (v: string) => string): Choice[] =>
  Array.from(new Set([...known, ...present]))
    .sort((a, b) => a.localeCompare(b))
    .map((v) => ({ value: v, label: label?.(v) ?? titleize(v) }));

/**
 * The scoring fields, with the fit lists built from what this database
 * actually contains.
 *
 * These were comma-separated text boxes holding raw `icp_code` values, so
 * getting full ICP weight meant knowing the vocabulary by heart and spelling
 * it correctly — a typo silently scored every matching record lower, with
 * nothing to indicate why.
 */
export function scoringFields(facets: ScoringFacets = { icp: [], vertical: [] }): PolicyField[] {
  const icpChoices = choices(Object.keys(ICP_LABELS), facets.icp, (v) => ICP_LABELS[v] ?? titleize(v));
  const verticalChoices = choices(VERTICALS, facets.vertical);

  return [
    ...SCORING_BASE,
    {
      path: 'strategicIcps',
      label: 'Strategic ICPs',
      kind: 'multiselect',
      group: 'Fit lists',
      choices: icpChoices,
      emptyLabel: 'no profile earns the ICP weight',
      hint: 'These take the full ICP weight.',
      wide: true,
    },
    {
      path: 'secondaryIcps',
      label: 'Secondary ICPs',
      kind: 'multiselect',
      group: 'Fit lists',
      choices: icpChoices,
      emptyLabel: 'nothing scores at half weight',
      hint: 'Half the ICP weight. A profile listed as strategic wins — it is checked first.',
      wide: true,
    },
    {
      path: 'coreVerticals',
      label: 'Core verticals',
      kind: 'multiselect',
      group: 'Fit lists',
      choices: verticalChoices,
      emptyLabel: 'no vertical earns the top-up',
      hint: 'A record in one of these gets a +25% top-up on its ICP score, on top of whatever its profile earned.',
      wide: true,
    },
  ];
}
