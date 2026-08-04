import { Card, CardBody, Skeleton } from '@/components/ui';

/**
 * What you see the instant you click, instead of nothing.
 *
 * There was no loading boundary anywhere in the app, so every navigation held the
 * old page on screen until the new one had rendered completely on the server.
 * Measured on the production build: the Dashboard took 21 seconds and Operations
 * 12, during which a click produced no visible response at all — which is what
 * "navigation is slow" actually meant. The pages were not just slow, they were
 * silent.
 *
 * This is a Suspense boundary for the whole app: the rail and topbar stay put and
 * the content area shows this until the page streams in. It does not make any
 * query faster — that work is separate — but it makes a click respond immediately
 * and shows roughly the shape of what is coming.
 *
 * Deliberately generic. A skeleton that mimicked one page exactly would be wrong
 * on every other, and a boundary this high covers them all.
 */
export default function Loading() {
  return (
    <div className="animate-fade-in" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      {/* The heading block every page starts with. */}
      <Skeleton className="h-7 w-56" />
      <Skeleton className="mt-2 h-4 w-full max-w-2xl" />

      {/* A row of stat tiles, which is what sits under the heading on the
          Dashboard and most of the Operations pages. */}
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="p-4">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="mt-2 h-6 w-16" />
            <Skeleton className="mt-1.5 h-2.5 w-24" />
          </Card>
        ))}
      </div>

      {/* Then the first panel — a table or a list. */}
      <Card className="mt-6">
        <CardBody>
          <Skeleton className="h-4 w-40" />
          <div className="mt-4 space-y-2.5">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-3 w-28 shrink-0" />
                <Skeleton className="h-3 flex-1" />
                <Skeleton className="h-3 w-14 shrink-0" />
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
