import Image from 'next/image';

/**
 * The Evercam mark.
 *
 * The wordmark is two-tone — EVER in brand red, CAM in black — so one file
 * cannot serve both surfaces: on a dark background the black half simply
 * disappears. Tinting is not an option either, since it would take the red
 * with it. So two files ship, differing only in that half.
 *
 * `on` names the BACKGROUND the mark sits on, not the theme. They are not the
 * same thing here: the topbar and rail are dark in both themes, so a
 * theme-derived choice would black out half the wordmark in light mode. Only
 * surfaces that actually follow the theme pass `on="auto"`, and that case
 * renders both and lets CSS pick — no JavaScript, and no flash against the
 * pre-paint theme script.
 */
export default function Logo({
  variant = 'wordmark',
  on = 'auto',
  width = 116,
  className = '',
  priority = false,
}: {
  variant?: 'wordmark' | 'mark';
  on?: 'light' | 'dark' | 'auto';
  /** Rendered width in px. The source is 260×51 — stay under it to keep it crisp. */
  width?: number;
  className?: string;
  priority?: boolean;
}) {
  if (variant === 'mark') {
    // The icon is a single colour and reads on anything.
    return (
      <Image
        src="/evercam-icon.png"
        alt="Evercam"
        width={width}
        height={Math.round((width * 51) / 52)}
        className={className}
        priority={priority}
      />
    );
  }

  const height = Math.round((width * 51) / 260);
  const size = { width, height };

  if (on !== 'auto') {
    return (
      <Image
        src={on === 'dark' ? '/evercam-logo-dark.png' : '/evercam-logo.png'}
        alt="Evercam"
        {...size}
        priority={priority}
        className={`${className} h-auto`}
      />
    );
  }

  return (
    <>
      <Image
        src="/evercam-logo.png"
        alt="Evercam"
        {...size}
        priority={priority}
        className={`${className} h-auto dark:hidden`}
      />
      {/* Decorative duplicate — the visible one above already names the brand,
          and a second alt would have screen readers say it twice. */}
      <Image
        src="/evercam-logo-dark.png"
        alt=""
        aria-hidden="true"
        {...size}
        priority={priority}
        className={`${className} hidden h-auto dark:block`}
      />
    </>
  );
}
