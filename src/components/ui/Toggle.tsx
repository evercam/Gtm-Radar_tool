'use client';

/**
 * Compact switch, sized to sit inline in a dense row (8×4 track, 3×3 knob).
 *
 * Renders a real checkbox behind it rather than a styled div, so it stays
 * keyboard-operable, announces its state to a screen reader, and works inside
 * a form — none of which a click-handled div gives you.
 */
export default function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  hideLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  /** Keep the label for assistive tech but don't render it. */
  hideLabel?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2.5 ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
      <span className="relative inline-flex shrink-0">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span
          className={`peer-focus-visible:outline-brand block h-4 w-8 rounded-full transition-colors duration-200 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 ${
            checked ? 'bg-brand' : 'bg-border-strong'
          }`}
        />
        <span
          className={`pointer-events-none absolute left-0.5 top-0.5 block h-3 w-3 rounded-full bg-white shadow transition-transform duration-200 ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </span>

      <span className={hideLabel ? 'sr-only' : 'min-w-0'}>
        <span className="text-body block text-[11px] font-medium">{label}</span>
        {description ? <span className="text-muted block text-[10px]">{description}</span> : null}
      </span>
    </label>
  );
}
