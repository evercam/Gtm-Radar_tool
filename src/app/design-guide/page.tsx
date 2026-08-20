import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  Callout,
  CalloutCode,
  Card,
  CardBody,
  CardHeader,
  Chip,
  EmptyState,
  Field,
  Label,
  ProgressBar,
  ScoreRing,
  SectionTitle,
  Skeleton,
  Stat,
  StatusDot,
  Table,
  TBody,
  Td,
  Th,
  THead,
  TableShell,
} from '@/components/ui';
import { badgeTone, dangerHoverText, provenanceChip, rowTone, statusText } from '@/lib/status-colors';
import { cn } from '@/lib/cn';

/**
 * The living showcase. ProductOS keeps one of these per app, and it is the
 * source of truth for how things look.
 *
 * It exists because drift is invisible in a codebase and obvious on a page. Both
 * inconsistencies found in the last review — EnrichPanel painting "good" on a
 * different green from every Badge, and provenance wearing the success hue —
 * would have been caught in one glance here, because the two sit centimetres
 * apart. In the diff they were fifty files away from each other.
 *
 * Rules, from the skill: a new reusable component MUST get a section here, with
 * every variant and state. Change a component's API and its section changes with
 * it. Foundations first, then primitives, then composition.
 *
 * Deliberately static — no data, no session reads. This page has to render when
 * Supabase is down, or it cannot be used to check anything.
 */
export const metadata = { title: 'Design guide' };

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} subtitle={note} />
      <CardBody className="space-y-5">{children}</CardBody>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-border-base flex flex-wrap items-center gap-3 border-b pb-3 last:border-0 last:pb-0">
      <span className="text-subtle w-32 shrink-0 font-mono text-[10px] uppercase tracking-wider">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/*
  Written out rather than generated from the token list.

  `bg-${t}` would be a dynamic class name, and Tailwind resolves classes by
  scanning source text — a constructed string produces no CSS at all. That is the
  same failure mode as the three dead `-raised` utilities this guide exists to
  prevent, so the swatches are literal.
*/
const SURFACES: { token: string; className: string }[] = [
  { token: '--background', className: 'bg-background' },
  { token: '--surface', className: 'bg-surface' },
  { token: '--surface-raised', className: 'bg-surface-raised' },
];

const TEXT: { token: string; className: string }[] = [
  { token: '--foreground', className: 'text-foreground' },
  { token: '--body', className: 'text-body' },
  { token: '--muted', className: 'text-muted' },
  { token: '--subtle', className: 'text-subtle' },
];

const SEMANTIC: { token: string; className: string }[] = [
  { token: '--brand', className: 'bg-brand' },
  { token: '--success', className: 'bg-success' },
  { token: '--warning', className: 'bg-warning' },
  { token: '--danger', className: 'bg-danger' },
  { token: '--info', className: 'bg-info' },
];

const TYPE_SCALE: { name: string; className: string }[] = [
  { name: 'Page title', className: 'text-xl font-bold' },
  { name: 'Section title', className: 'text-lg font-semibold' },
  { name: 'Card title', className: 'text-sm font-bold' },
  { name: 'Body', className: 'text-sm' },
  { name: 'Meta (11px)', className: 'text-muted text-[11px]' },
  { name: 'Label (10px caps)', className: 'text-muted text-[10px] font-bold uppercase tracking-[0.14em]' },
  { name: 'Mono identifier', className: 'text-muted font-mono text-xs' },
];

const ROWS: [string, string, number][] = [
  ['Dublin data centre', 'Pre-construction', 92],
  ['Cork substation', 'Permitting', 64],
  ['Galway retrofit', 'Operating', 12],
];

export default function DesignGuidePage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-foreground text-xl font-bold">Design guide</h1>
        <p className="text-muted mt-1 text-[11px]">
          Every reusable primitive, in every state. If something here looks wrong, it is wrong everywhere.
        </p>
      </div>

      <Section title="Colour" note="Tokens only — a raw hex in a component fails test-design-tokens.mjs.">
        <div>
          <SectionTitle>Surfaces</SectionTitle>
          <div className="flex flex-wrap gap-3">
            {SURFACES.map((s) => (
              <div key={s.token} className="w-32">
                <div className={cn('border-border-base h-12 rounded-lg border', s.className)} />
                <p className="text-subtle mt-1 font-mono text-[10px]">{s.token}</p>
              </div>
            ))}
          </div>
        </div>
        <div>
          <SectionTitle>Text</SectionTitle>
          <div className="space-y-1">
            {TEXT.map((t) => (
              <p key={t.token} className={cn('text-sm', t.className)}>
                The quick brown fox — <span className="font-mono text-[10px]">{t.token}</span>
              </p>
            ))}
          </div>
        </div>
        <div>
          <SectionTitle>Semantic</SectionTitle>
          <div className="flex flex-wrap gap-3">
            {SEMANTIC.map((s) => (
              <div key={s.token} className="w-24">
                <div className={cn('h-12 rounded-lg', s.className)} />
                <p className="text-subtle mt-1 font-mono text-[10px]">{s.token}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Typography" note="Seven steps. Anything outside this list is drift.">
        <div className="space-y-3">
          {TYPE_SCALE.map((t) => (
            <div key={t.name} className="border-border-base flex items-baseline gap-4 border-b pb-2 last:border-0">
              <span className="text-subtle w-36 shrink-0 font-mono text-[10px]">{t.name}</span>
              <span className={t.className}>Leads that arrive before the window</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Status" note="One tone vocabulary, defined once in lib/status-colors.ts and imported everywhere.">
        <Row label="Badge">
          {(Object.keys(badgeTone) as (keyof typeof badgeTone)[]).map((t) => (
            <Badge key={t} tone={t}>
              {t}
            </Badge>
          ))}
        </Row>
        <Row label="+ className">
          {/* The regression that shipped: a margin used to replace the whole tone. */}
          <Badge tone="warning" className="ml-2">
            keeps its colour
          </Badge>
          <Badge tone="danger" className="ml-2">
            and so does this
          </Badge>
        </Row>
        <Row label="Provenance">
          {['source', 'claude', 'apollo', 'gleif'].map((o) => (
            <span key={o} className={cn('rounded border px-1.5 py-0.5 text-[10px] font-medium', provenanceChip)}>
              {o}
            </span>
          ))}
          <span className="text-subtle text-[10px]">identity, never a status hue</span>
        </Row>
        <Row label="StatusDot">
          {(['ok', 'warn', 'bad', 'idle'] as const).map((t) => (
            <span key={t} className="text-muted inline-flex items-center gap-1.5 text-[11px]">
              <StatusDot tone={t} />
              {t}
            </span>
          ))}
        </Row>
        <Row label="Chip">
          <Chip active>active</Chip>
          <Chip>inactive</Chip>
        </Row>
      </Section>

      <Section title="Controls">
        <Row label="Button">
          {(['primary', 'secondary', 'ghost', 'danger'] as const).map((v) => (
            <Button key={v} variant={v}>
              {v}
            </Button>
          ))}
        </Row>
        <Row label="success">
          {/*
            Green rather than brand, and worth a decision: ProductOS reads emerald
            as "succeeded", not "go". Two bulk actions wear it today because they
            always have — see successAction in status-colors.ts.
          */}
          <Button variant="success">Score &amp; route all records →</Button>
        </Row>
        <Row label="size=sm">
          <Button size="sm" variant="primary">
            small
          </Button>
          <Button size="sm">small</Button>
        </Row>
        <Row label="disabled">
          <Button variant="primary" disabled>
            disabled
          </Button>
        </Row>
        <div>
          <SectionTitle>Field</SectionTitle>
          <div className="max-w-xs space-y-3">
            <Field label="Daily quota" hint="per person">
              <input
                readOnly
                value="50"
                className="border-border-base bg-surface w-full rounded border px-2 py-1.5 text-sm"
              />
            </Field>
            <Label hint="(optional)">Standalone label</Label>
          </div>
        </div>
      </Section>

      <Section title="Status as text" note="A figure that is itself the signal. One red, not two.">
        <Row label="statusText">
          {(['success', 'warning', 'danger', 'info'] as const).map((t) => (
            <span key={t} className={cn('text-sm font-semibold tabular-nums', statusText[t])}>
              {t} 1,247
            </span>
          ))}
        </Row>
        <Row label="rowTone.danger">
          <div className="w-full">
            <table className="w-full text-left text-sm">
              <tbody>
                <tr>
                  <Td>a row that succeeded</Td>
                </tr>
                <tr className={rowTone.danger}>
                  <Td>a row whose record failed</Td>
                </tr>
              </tbody>
            </table>
          </div>
        </Row>
        <Row label="dangerHoverText">
          <button className={cn('text-muted text-xs', dangerHoverText)}>remove (hover me)</button>
        </Row>
      </Section>

      <Section title="Data display">
        <Row label="Stat">
          <div className="grid w-full gap-3 sm:grid-cols-3">
            <Stat label="Assigned" value="1,247" note="+18 today" />
            <Stat label="Past window" value="31,417" note="not exported" tone="warning" />
            <Stat label="Failed" value="3" tone="danger" />
          </div>
        </Row>
        <Row label="ScoreRing">
          {[92, 64, 41, 12].map((s) => (
            <ScoreRing key={s} score={s} label={`score ${s}`} />
          ))}
        </Row>
        <Row label="ProgressBar">
          <div className="w-full space-y-2">
            {(['brand', 'success', 'warning', 'danger', 'neutral'] as const).map((t) => (
              <ProgressBar key={t} value={t === 'neutral' ? 20 : 68} tone={t} />
            ))}
          </div>
        </Row>
        <div>
          <SectionTitle>Table</SectionTitle>
          <TableShell footer={<span className="text-subtle text-[10px]">3 of 111,353</span>}>
            <Table>
              <THead>
                <tr>
                  <Th>Project</Th>
                  <Th>Phase</Th>
                  <Th align="right">Score</Th>
                </tr>
              </THead>
              <TBody>
                {ROWS.map(([name, phase, score]) => (
                  <tr key={name}>
                    <Td>
                      <span className="text-foreground">{name}</span>
                    </Td>
                    <Td>{phase}</Td>
                    <Td align="right">{score}</Td>
                  </tr>
                ))}
              </TBody>
            </Table>
          </TableShell>
        </div>
      </Section>

      <Section
        title="Callout"
        note="The not-set-up / degraded banner. Five components wrote this by hand; one had already drifted."
      >
        <div className="space-y-3">
          <Callout>
            An inline strip, <CalloutCode>size=&quot;sm&quot;</CalloutCode> — what a panel puts above its own controls.
          </Callout>
          <Callout tone="danger">The same strip in danger, for a state that has already failed.</Callout>
          <Callout size="md" title="A titled block">
            <p>
              <CalloutCode>size=&quot;md&quot;</CalloutCode> replaces a whole page&apos;s content when the page cannot
              work at all. The title slot is one shade stronger than the body — at these tints, weight alone does not
              separate them.
            </p>
          </Callout>
        </div>
      </Section>

      <Section title="Absence" note="What a surface shows when it has nothing — never a blank area.">
        <div>
          <SectionTitle>EmptyState</SectionTitle>
          <EmptyState
            title="Nothing eligible"
            description="Of 29 assigned: 22 already sent to Apollo, 7 with no email address."
            action={<Button variant="primary">Run enrichment</Button>}
          />
        </div>
        <div>
          <SectionTitle>Skeleton</SectionTitle>
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
      </Section>
    </div>
  );
}
