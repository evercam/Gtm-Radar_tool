import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Class name merge for every component that accepts a `className` override.
 *
 * The obvious implementation — join the truthy parts with a space — is what
 * `components/ui` used before this, and it silently does not do what a caller
 * expects. `<Card className="rounded-lg">` emitted BOTH `rounded-2xl` (the
 * component's own) and `rounded-lg` (the override). Two classes of equal
 * specificity, so the winner is whichever Tailwind emitted later in the
 * stylesheet, not the one the caller asked for. The override appeared to work
 * or not depending on class ordering inside Tailwind's output — which changes
 * as utilities are added elsewhere in the app.
 *
 * `twMerge` resolves conflicts by utility group, so the last value for a group
 * wins and the earlier one is dropped from the output entirely. That is what
 * makes a `className` prop an actual override rather than a suggestion.
 *
 * Custom tokens from globals.css (`text-muted`, `bg-surface-raised`,
 * `border-border-base`) merge correctly without configuration: tailwind-merge
 * groups by utility prefix, and an unrecognised value on a colour prefix is
 * treated as a colour — which is what these are.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
