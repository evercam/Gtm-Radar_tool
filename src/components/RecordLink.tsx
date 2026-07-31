import Link from 'next/link';
import { type ReactNode } from 'react';

/**
 * Opens a record's detail drawer from anywhere it is listed.
 *
 * One component rather than the same `href` written out in four places, because
 * the four places had drifted into four different behaviours: the records table
 * and the dashboard linked to the ACCOUNT page and only when `account_key` was
 * set (so ~99% of rows were dead text), the account page linked to a keyword
 * SEARCH for the record's own name, and the enrichment queue linked out to the
 * vendor's site or nowhere. None of them opened the record.
 *
 * The drawer lives on /records and reads `?record=`, so every entry point is
 * this one URL. Callers that are already on /records should build the href with
 * their own `qs(base, { record: id })` instead, to keep the user's filters —
 * this component deliberately does not know about them.
 */
export default function RecordLink({
  id,
  children,
  className = 'hover:underline',
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link href={`/records?record=${encodeURIComponent(id)}`} prefetch={false} className={className}>
      {children}
    </Link>
  );
}
