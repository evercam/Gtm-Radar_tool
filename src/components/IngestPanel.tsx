'use client';

import { useState } from 'react';

interface FieldSpec {
  key: 'minValue' | 'keyword' | 'postcodes' | 'sectors' | 'regions';
  label: string;
  placeholder: string;
  type: 'number' | 'text';
}

interface SourceConfig {
  slug: 'barbour-abi' | 'glenigan' | 'construct-connect' | 'sam-gov';
  label: string;
  /** Only the vendor's REAL, confirmed filter capabilities — see AdapterFetchParams in lib/adapters/types.ts. */
  fields: FieldSpec[];
}

const SOURCES: SourceConfig[] = [
  {
    slug: 'barbour-abi',
    label: 'Barbour ABI',
    fields: [
      { key: 'minValue', label: 'Min value (GBP)', placeholder: 'e.g. 500000', type: 'number' },
      { key: 'keyword', label: 'Keyword', placeholder: 'project_text match', type: 'text' },
      { key: 'postcodes', label: 'Postcodes (comma-separated)', placeholder: 'e.g. NE1, NE6', type: 'text' },
    ],
  },
  {
    slug: 'glenigan',
    label: 'Glenigan',
    fields: [
      { key: 'minValue', label: 'Min value (GBP)', placeholder: 'e.g. 500000', type: 'number' },
      { key: 'keyword', label: 'Keyword', placeholder: 'title/description match', type: 'text' },
      { key: 'sectors', label: 'Sectors (comma-separated)', placeholder: 'e.g. Retail, Private Housing', type: 'text' },
      {
        key: 'regions',
        label: 'Regions/towns (comma-separated)',
        placeholder: 'e.g. North East, Newcastle',
        type: 'text',
      },
    ],
  },
  {
    slug: 'construct-connect',
    label: 'ConstructConnect',
    fields: [
      { key: 'minValue', label: 'Min value (USD)', placeholder: 'e.g. 1000000', type: 'number' },
      { key: 'keyword', label: 'Keyword', placeholder: 'title/description match', type: 'text' },
      { key: 'sectors', label: 'Categories (comma-separated)', placeholder: 'e.g. Retail, Educational', type: 'text' },
      { key: 'regions', label: 'States (comma-separated)', placeholder: 'e.g. California, Texas', type: 'text' },
    ],
  },
  {
    slug: 'sam-gov',
    label: 'SAM.gov',
    fields: [
      { key: 'keyword', label: 'Keyword', placeholder: 'e.g. bridge, water treatment', type: 'text' },
      { key: 'sectors', label: 'NAICS code', placeholder: 'e.g. 237310 (default 23 = all construction)', type: 'text' },
      { key: 'regions', label: 'States (comma-separated)', placeholder: 'e.g. California, Texas', type: 'text' },
      { key: 'minValue', label: 'Min award value (USD)', placeholder: 'e.g. 1000000', type: 'number' },
    ],
  },
];

function defaultSince(): string {
  const d = new Date(Date.now() - 180 * 86_400_000); // matches both adapters' default lookback
  return d.toISOString().slice(0, 10);
}

function defaultUntil(): string {
  return new Date().toISOString().slice(0, 10);
}

type FormState = Record<string, string>;

function buildBody(slug: string, form: FormState): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const since = form[`${slug}-since`];
  const until = form[`${slug}-until`];
  if (since) body.since = since;
  if (until) body.until = until;

  const minValue = form[`${slug}-minValue`];
  if (minValue) body.minValue = Number(minValue);

  const keyword = form[`${slug}-keyword`];
  if (keyword?.trim()) body.keyword = keyword.trim();

  const postcodes = form[`${slug}-postcodes`];
  if (postcodes?.trim())
    body.postcodes = postcodes
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const sectors = form[`${slug}-sectors`];
  if (sectors?.trim())
    body.sectors = sectors
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const regions = form[`${slug}-regions`];
  if (regions?.trim())
    body.regions = regions
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  return body;
}

export default function IngestPanel() {
  const [form, setForm] = useState<FormState>({});
  const [results, setResults] = useState<Record<string, unknown>>({});
  const [testResults, setTestResults] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  function setField(slug: string, key: string, value: string) {
    setForm((f) => ({ ...f, [`${slug}-${key}`]: value }));
  }

  async function runIngestion(slug: string) {
    setLoading((s) => ({ ...s, [slug]: true }));
    try {
      const res = await fetch(`/api/ingest/${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(slug, form)),
      });
      const json = await res.json();
      setResults((r) => ({ ...r, [slug]: json }));
    } catch (err) {
      setResults((r) => ({ ...r, [slug]: { error: err instanceof Error ? err.message : String(err) } }));
    } finally {
      setLoading((s) => ({ ...s, [slug]: false }));
    }
  }

  async function testConnection(slug: string) {
    setLoading((s) => ({ ...s, [`test-${slug}`]: true }));
    try {
      const res = await fetch(`/api/ingest/${slug}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(slug, form)),
      });
      const json = await res.json();
      setTestResults((r) => ({ ...r, [slug]: json }));
    } catch (err) {
      setTestResults((r) => ({ ...r, [slug]: { error: err instanceof Error ? err.message : String(err) } }));
    } finally {
      setLoading((s) => ({ ...s, [`test-${slug}`]: false }));
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      {SOURCES.map((source) => (
        <div key={source.slug} className="rounded-lg border border-border-base bg-surface p-5">
          <h3 className="text-base font-semibold text-foreground">{source.label}</h3>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="text-xs text-muted">
              Since
              <input
                type="date"
                defaultValue={defaultSince()}
                onChange={(e) => setField(source.slug, 'since', e.target.value)}
                className="mt-0.5 w-full rounded border border-border-base bg-surface px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-muted">
              Until
              <input
                type="date"
                defaultValue={defaultUntil()}
                onChange={(e) => setField(source.slug, 'until', e.target.value)}
                className="mt-0.5 w-full rounded border border-border-base bg-surface px-2 py-1 text-sm"
              />
            </label>

            {source.fields.map((f) => (
              <label key={f.key} className="col-span-2 text-xs text-muted">
                {f.label}
                <input
                  type={f.type}
                  placeholder={f.placeholder}
                  onChange={(e) => setField(source.slug, f.key, e.target.value)}
                  className="mt-0.5 w-full rounded border border-border-base bg-surface px-2 py-1 text-sm"
                />
              </label>
            ))}
          </div>
          {source.slug === 'glenigan' ? (
            <p className="mt-1.5 text-[11px] text-muted">
              Sectors/regions/min-value are applied client-side after fetch — Glenigan&rsquo;s new-project endpoint only
              supports server-side date-range and pagination filters.
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => testConnection(source.slug)}
              disabled={loading[`test-${source.slug}`]}
              className="rounded border border-border-base px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-raised disabled:opacity-50-raised"
            >
              {loading[`test-${source.slug}`] ? 'Testing…' : 'Test Connection'}
            </button>
            <button
              onClick={() => runIngestion(source.slug)}
              disabled={loading[source.slug]}
              className="rounded bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-surface-raised disabled:opacity-50-raised"
            >
              {loading[source.slug] ? 'Running…' : `Run ${source.label} Search`}
            </button>
          </div>

          {testResults[source.slug] !== undefined ? (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Test Connection Result</p>
              <pre className="mt-1 max-h-64 overflow-auto rounded bg-surface-raised p-2 text-xs text-muted">
                {JSON.stringify(testResults[source.slug], null, 2)}
              </pre>
            </div>
          ) : null}

          {results[source.slug] !== undefined ? (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Ingestion Result</p>
              <pre className="mt-1 max-h-64 overflow-auto rounded bg-surface-raised p-2 text-xs text-muted">
                {JSON.stringify(results[source.slug], null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
