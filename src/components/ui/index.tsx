/**
 * Shared UI primitives.
 *
 * The visual language follows the Evercam admin console: 16px cards with a
 * hairline border and almost no shadow, 8px controls, and a deliberately dense
 * type scale — 10px uppercase labels, 11px meta, 12px body. Colour comes from
 * the tokens in globals.css, so a token change moves the whole app at once.
 *
 * Server-component safe: nothing here uses hooks or browser APIs. Interactive
 * primitives (Modal, Drawer, Toast, Toggle) live in their own client modules.
 */

import Link from 'next/link';
import type { ReactNode, HTMLAttributes, ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import {
  badgeTone,
  calloutTone,
  calloutTitleTone,
  calloutCodeTone,
  successAction,
  statusText,
  type StatusTextTone,
  type CalloutTone as CalloutToneName,
  statusDot,
  progressTone,
  type BadgeTone,
  type StatusDotTone,
  type ProgressTone,
} from '@/lib/status-colors';

/* -------------------------------------------------------------------------- */
/* Card                                                                        */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  className,
  interactive,
  ...rest
}: { children: ReactNode; interactive?: boolean } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'border-border-base bg-surface rounded-2xl border shadow-[var(--shadow-card)]',
        interactive && 'transition-shadow duration-200 hover:shadow-[var(--shadow-card-hover)]',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="border-border-base flex items-start justify-between gap-4 border-b px-5 py-4">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-bold">{title}</p>
        {subtitle ? <p className="text-muted mt-0.5 text-[11px]">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-5 py-5', className)}>{children}</div>;
}

/**
 * The small uppercase heading that opens each block. Tight tracking at 10px is
 * what makes the reference read as a console rather than a marketing page.
 */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <p className="text-muted mb-4 text-[10px] font-bold uppercase tracking-[0.14em]">{children}</p>;
}

/** Form label — the same treatment, one step tighter. */
export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <span className="text-muted mb-1.5 block text-[10px] font-bold uppercase tracking-widest">
      {children}
      {hint ? <span className="text-subtle ml-1 font-normal normal-case tracking-normal">{hint}</span> : null}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/** Shared control styling — inputs and selects must look identical. */
export const controlClass =
  'w-full rounded-lg border border-border-base bg-surface-raised px-3 py-2 text-xs text-foreground ' +
  'placeholder:text-subtle focus:border-brand/50 focus:outline-none transition-colors';

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('block', className)}>
      <Label hint={hint}>{label}</Label>
      {children}
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Badge, Chip, StatusDot                                                      */
/* -------------------------------------------------------------------------- */

export function Badge({
  children,
  tone = 'neutral',
  className,
  title,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
        /*
          Tone first, then the caller's classes — NOT `className ?? tones[tone]`.

          The `??` made any className replace the whole tone, so the only two
          badges that needed a margin lost their colour with it. `<Badge
          tone="warning" className="ml-2">inactive</Badge>` in HandoverByPerson
          rendered as plain grey text, and that badge is, by its own comment, the
          only place a rep sees that an inactive person is holding leads the
          export will skip. A warning that cannot be told apart from a label is
          not a warning.

          cn() is what makes tone-plus-override safe: `ml-2` does not collide with
          a colour group, so both survive, and a caller who really does pass
          `bg-*` still wins by utility group. That is the same reasoning the
          chrome-token commit applied everywhere else in this file; this line was
          the one it missed.
        */
        badgeTone[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * Selectable pill. The active state is a tinted brand outline rather than a
 * solid fill — a row of solid red chips would fight the navbar for attention.
 */
export function Chip({
  children,
  active,
  onClick,
  href,
  title,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  href?: string;
  title?: string;
}) {
  const className = cn(
    'inline-block rounded-lg border px-2.5 py-1 text-[10px] font-semibold transition-colors',
    active
      ? 'border-brand/40 bg-brand/10 text-brand'
      : 'border-border-base bg-surface-raised text-muted hover:border-border-strong hover:text-foreground'
  );
  if (href) {
    return (
      <a href={href} title={title} className={className}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} title={title} className={className}>
      {children}
    </button>
  );
}

/** Live/idle indicator. Deliberately tiny — it reads as state, not decoration. */
export function StatusDot({ tone = 'idle' }: { tone?: StatusDotTone }) {
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', statusDot[tone])} />;
}

/* -------------------------------------------------------------------------- */
/* Button                                                                      */
/* -------------------------------------------------------------------------- */

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
  size?: 'sm' | 'md';
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const variants: Record<string, string> = {
    primary: 'bg-brand text-brand-contrast hover:bg-brand-hover font-bold',
    secondary: 'border border-border-base text-body hover:bg-surface-raised hover:text-foreground',
    ghost: 'text-muted hover:bg-surface-raised hover:text-foreground',
    danger: 'bg-danger text-white hover:opacity-90 font-bold',
    success: successAction,
  };
  const sizes: Record<string, string> = {
    sm: 'px-3 py-1.5 text-[11px]',
    md: 'px-5 py-2 text-xs',
  };
  return (
    <button
      className={cn(
        'rounded-lg font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40',
        'focus-visible:outline-brand focus-visible:outline-2 focus-visible:outline-offset-2',
        variants[variant],
        sizes[size],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Stat                                                                        */
/* -------------------------------------------------------------------------- */

export function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'success' | 'warning' | 'danger';
}) {
  const toneClass = tone
    ? { success: 'text-success', warning: 'text-warning', danger: 'text-danger' }[tone]
    : 'text-foreground';
  return (
    <Card className="p-4">
      <p className="text-muted text-[10px] font-bold uppercase tracking-widest">{label}</p>
      <p className={cn('mt-1.5 text-xl font-bold tabular-nums', toneClass)}>{value}</p>
      {note ? <p className="text-subtle mt-0.5 text-[10px]">{note}</p> : null}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* ScoreRing                                                                   */
/* -------------------------------------------------------------------------- */

export function ScoreRing({ score, size = 56, label }: { score: number; size?: number; label?: string }) {
  const clamped = Math.max(0, Math.min(100, score));
  const stroke = size >= 56 ? 5 : 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (clamped / 100) * circumference;

  const color =
    clamped >= 75 ? 'var(--brand)' : clamped >= 55 ? 'var(--warning)' : clamped >= 35 ? 'var(--info)' : 'var(--subtle)';

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      title={label}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
          style={{ transition: 'stroke-dasharray 400ms ease-out' }}
        />
      </svg>
      <span className="text-foreground absolute text-xs font-bold tabular-nums">{clamped}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* ProgressBar                                                                 */
/* -------------------------------------------------------------------------- */

export function ProgressBar({
  value,
  max = 100,
  tone = 'brand',
  className,
}: {
  value: number;
  max?: number;
  tone?: ProgressTone;
  className?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      className={cn('bg-surface-raised border-border-base h-1.5 overflow-hidden rounded-full border', className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-300', progressTone[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* EmptyState & Skeleton                                                       */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="border-border-base bg-surface-raised rounded-2xl border border-dashed px-6 py-10 text-center">
      {icon ? <div className="text-subtle mx-auto mb-3 flex justify-center">{icon}</div> : null}
      <p className="text-foreground text-xs font-bold">{title}</p>
      {description ? <p className="text-muted mx-auto mt-1.5 max-w-md text-[11px]">{description}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded', className)} aria-hidden="true" />;
}

export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-border-base border-b px-4 py-3">
        <Skeleton className="h-2.5 w-32" />
      </div>
      <div className="divide-border-base divide-y">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex gap-4 px-4 py-3">
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton key={c} className={cn('h-2.5', c === 0 ? 'w-1/3' : 'flex-1')} />
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Table                                                                       */
/* -------------------------------------------------------------------------- */

export function TableShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">{children}</div>
      {footer ? <div className="border-border-base text-subtle border-t px-4 py-2.5 text-[10px]">{footer}</div> : null}
    </Card>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <table className={cn('w-full text-left text-xs', className)}>{children}</table>;
}

export function Th({
  children,
  align = 'left',
  className,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <th
      className={cn(
        'text-muted px-3 py-2.5 text-[10px] font-bold uppercase tracking-widest',
        align === 'right' && 'text-right',
        className
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  className,
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td className={cn('text-body px-3 py-2', align === 'right' && 'text-right tabular-nums', className)}>{children}</td>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="bg-surface-raised border-border-base sticky top-0 z-10 border-b">{children}</thead>;
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-border-base divide-y">{children}</tbody>;
}

/* -------------------------------------------------------------------------- */
/* Callout                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The "this is not set up / this is degraded" banner.
 *
 * Five components had written this box by hand. Four shared one class string
 * exactly; the fifth had drifted to dark:bg-amber-950/30 against the others' /40,
 * which is invisible in review and permanent once shipped. That is the whole case
 * for a component: not that the box is hard to write, but that writing it five
 * times guarantees five slightly different boxes.
 *
 * `size` is real density, not decoration. `sm` is the inline strip a panel puts
 * above its own controls; `md` is the block that replaces a whole page's content
 * when the page cannot work at all.
 */
export function Callout({
  tone = 'warning',
  size = 'sm',
  title,
  children,
  className,
}: {
  tone?: CalloutToneName;
  size?: 'sm' | 'md';
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'border',
        size === 'sm' ? 'rounded px-3 py-2 text-xs' : 'rounded-lg p-5 text-sm',
        calloutTone[tone],
        className
      )}
    >
      {title ? (
        <p className={cn('font-semibold', size === 'sm' ? 'text-xs' : 'text-sm', calloutTitleTone[tone])}>{title}</p>
      ) : null}
      <div className={title ? 'mt-1' : undefined}>{children}</div>
    </div>
  );
}

/**
 * Inline code inside a Callout.
 *
 * A plain <code> inherits the page's grey chip, which on an amber field reads as
 * a hole punched in the banner. This tints it from the banner's own ramp.
 */
export function CalloutCode({
  tone = 'warning',
  children,
}: {
  tone?: CalloutToneName;
  children: ReactNode;
}) {
  return <code className={cn('rounded px-1.5 py-0.5 font-mono', calloutCodeTone[tone])}>{children}</code>;
}

/* -------------------------------------------------------------------------- */
/* SectionHeading                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A band's title, with the links that belong to that band on the right.
 *
 * The dashboard wrote this three times and the two Operations pages write it
 * again — an h2, a flex row, a gap-4, and a cluster of underlined brand links.
 * Same markup four times means four chances for one of them to drift a weight or
 * a gap, which is the whole argument for the primitive.
 *
 * `actions` rather than children-on-the-right, because every copy put links there
 * and a named slot stops the next one putting them anywhere else.
 */
export function SectionHeading({
  title,
  actions,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <h2 className="text-foreground text-lg font-semibold">{title}</h2>
      {actions ? <div className="flex shrink-0 items-center gap-3 text-sm">{actions}</div> : null}
    </div>
  );
}

/**
 * Tile-shaped placeholders for a metric strip that streams.
 *
 * SkeletonTable is the wrong shape for this: the hero strip is a row of small
 * cards, and a fallback that is table-shaped makes the strip jump when the real
 * numbers arrive. Renders the SAME grid cells the resolved tiles will, so the
 * layout is decided before the data lands rather than after.
 */
export function SkeletonTiles({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} className="p-4">
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="mt-2.5 h-6 w-20" />
          <Skeleton className="mt-2 h-2 w-24" />
        </Card>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* MetricTile                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One number in a metric strip, and a place to go to see it.
 *
 * The dashboard hand-rolled this twice — "Act now" and "Owned by sales" were each
 * a Link wrapping a Card wrapping three <p>s, with the label at 10px caps, the
 * value at text-xl bold tabular-nums, and the note at 10px subtle. Two copies of
 * a tile is how a strip ends up with one tile a pixel taller than its neighbours.
 *
 * It is not `Stat`. Stat is a figure inside a panel; this is a tile that IS the
 * panel — it carries the card, the border, the hover affordance and the link. A
 * strip of Stats would have no target to click and no edge to align to.
 *
 * `tone` colours the VALUE and nothing else. The tile does not tint its own
 * background: a row of four tinted cards is a traffic light where three of the
 * lights are decoration, and the figure is what the eye is going to anyway.
 */
export function MetricTile({
  label,
  value,
  note,
  tone,
  href,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: StatusTextTone;
  /** Omit for a tile that is a readout rather than a way in. */
  href?: string;
  className?: string;
}) {
  const body = (
    <Card interactive={Boolean(href)} className="h-full p-4">
      <p className="text-muted text-[10px] font-bold uppercase tracking-widest">{label}</p>
      <p className={cn('mt-1.5 text-xl font-bold tabular-nums', tone ? statusText[tone] : 'text-foreground')}>
        {value}
      </p>
      {note ? <p className="text-subtle mt-0.5 text-[10px]">{note}</p> : null}
    </Card>
  );
  // `h-full` above plus the block wrapper is what keeps four tiles the same height
  // when one note wraps to two lines and the others do not.
  return href ? (
    <Link href={href} prefetch={false} className={cn('block', className)}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
