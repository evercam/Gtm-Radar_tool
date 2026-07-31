'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode } from 'react';
import Drawer from '@/components/ui/Drawer';

/**
 * Client shell around the record drawer.
 *
 * The drawer is open when the URL carries `?record=<id>`, so the record being
 * viewed is part of the address: it survives a refresh, it can be linked to a
 * colleague, and Back closes it. The only thing that has to run on the client
 * is closing — the body is server-rendered and passed in as children, so no
 * record data is fetched in the browser.
 *
 * `closeHref` is the same list URL minus `record`, which is why closing
 * preserves every filter, sort and page the user had applied.
 */
export default function RecordDrawer({
  title,
  closeHref,
  children,
}: {
  title: ReactNode;
  closeHref: string;
  children: ReactNode;
}) {
  const router = useRouter();

  return (
    <Drawer open onClose={() => router.push(closeHref, { scroll: false })} title={title} width="max-w-3xl">
      {children}
    </Drawer>
  );
}
