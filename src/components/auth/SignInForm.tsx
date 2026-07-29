import { Card, CardBody } from '@/components/ui';

/**
 * Sign-in.
 *
 * A link, not a form. The whole flow is server-side — /api/auth/google/start
 * mints the state and nonce and redirects — so this component ships no
 * JavaScript and touches no credentials. Password and magic-link sign-in went
 * with Supabase Auth: both existed to issue an identity this app now issues
 * itself, and keeping a password field would have meant keeping a second
 * credential store to secure.
 */

/** Google's mark. Inlined because the CSP forbids fetching it from Google. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8a10 10 0 0 1-4.4 6.6v5.4h7.1c4.1-3.8 6.6-9.5 6.6-16.2z"
      />
      <path
        fill="#34A853"
        d="M24 46c6 0 11-2 14.5-5.3l-7.1-5.4a13 13 0 0 1-19.4-6.8H4.7v5.6A22 22 0 0 0 24 46z"
      />
      <path fill="#FBBC05" d="M12 28.5a13 13 0 0 1 0-8.3v-5.6H4.7a22 22 0 0 0 0 19.5l7.3-5.6z" />
      <path
        fill="#EA4335"
        d="M24 9.5c3.2 0 6.2 1.1 8.5 3.3l6.3-6.3A21 21 0 0 0 24 2 22 22 0 0 0 4.7 14.6l7.3 5.6A13 13 0 0 1 24 9.5z"
      />
    </svg>
  );
}

export default function SignInForm({ next }: { next?: string }) {
  const href = `/api/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}`;

  return (
    <Card>
      <CardBody>
        <a
          href={href}
          className="border-border-strong bg-surface hover:bg-surface-raised text-foreground focus-visible:outline-brand flex w-full items-center justify-center gap-2.5 rounded-lg border px-4 py-2.5 text-sm font-medium focus-visible:outline-2"
        >
          <GoogleMark />
          Continue with Google
        </a>
        <p className="text-subtle mt-3 text-center text-[11px]">
          Use your work account. Access is granted by an admin.
        </p>
      </CardBody>
    </Card>
  );
}
