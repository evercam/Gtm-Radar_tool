'use client';

import { useState } from 'react';
import { ChevronDown, Upload } from 'lucide-react';
import { Badge, Button, StatusDot } from '@/components/ui';

/**
 * An upload source in the hub, shaped like the API-backed rows next to it.
 *
 * Uploads used to live on their own page, which made them look like a
 * different kind of thing. They are not: a CSV of key accounts and a GEM
 * tracker file land in the same `canonical_projects` table as every adapter.
 * The only real difference is the trigger — a file, not a schedule — so they
 * belong here, with a panel that opens where Query and Schedule open.
 */
export default function SourceUploadRow({
  name,
  coverage,
  recordCount,
  note,
  children,
}: {
  name: string;
  coverage: string;
  recordCount: number;
  note: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-border-base border-b last:border-b-0">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3">
        <StatusDot tone={recordCount > 0 ? 'ok' : 'idle'} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground text-[13px] font-bold">{name}</span>
            <Badge tone="neutral">upload</Badge>
          </div>
          <p className="text-muted mt-0.5 text-[11px]">
            {coverage} · {recordCount > 0 ? `${recordCount.toLocaleString()} records` : 'no records yet'} · on demand
          </p>
        </div>

        <Button size="sm" onClick={() => setOpen(!open)} className="flex items-center gap-1.5">
          <Upload size={12} strokeWidth={2.2} />
          Upload
          <ChevronDown size={11} className={open ? 'rotate-180' : ''} />
        </Button>
      </div>

      {open ? (
        <div className="border-border-base bg-surface-raised animate-rise-in border-t px-5 py-4">
          <p className="text-muted mb-3 text-[11px]">{note}</p>
          {children}
        </div>
      ) : null}
    </div>
  );
}
