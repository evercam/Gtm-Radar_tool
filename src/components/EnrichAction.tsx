'use client';

import { useState } from 'react';
import EnrichPanel from '@/components/EnrichPanel';

interface Rec {
  id?: string | null;
  canonical_name: string;
  record_type?: string | null;
  icp_code?: string | null;
  company_name_raw?: string | null;
  company_website?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  city?: string | null;
  state_province?: string | null;
  country?: string | null;
  source_key?: string | null;
  project_url?: string | null;
}

/**
 * "Enrich this account" — defers the EnrichPanel (which fetches on mount) until
 * clicked, so opening a detail page never spends an enrichment call. Persists
 * back to the account row via its id.
 */
export default function EnrichAction({ record }: { record: Rec }) {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <div className="overflow-hidden rounded-lg border border-border-base">
        <EnrichPanel record={record} />
      </div>
    );
  }
  return (
    <button
      onClick={() => setOpen(true)}
      className="rounded bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-surface-raised"
    >
      Enrich this account →
    </button>
  );
}
