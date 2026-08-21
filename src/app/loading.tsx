import LoadingMark from '@/components/shell/LoadingMark';

/**
 * What every route shows while the server renders it.
 *
 * Next serves this the moment a navigation starts and swaps it for the page when
 * the server is done, so it covers exactly the gap this app has: several reads
 * here take seconds, and until now that gap was a blank content area with the
 * chrome still up — which reads as a click that did not register.
 *
 * Route-level rather than per-panel on purpose. The panel fallbacks are skeletons
 * because a panel has a known shape worth promising; a whole page does not, and a
 * skeleton of a page you have not seen is a guess rendered as a fact.
 */
export default function Loading() {
  return <LoadingMark />;
}
