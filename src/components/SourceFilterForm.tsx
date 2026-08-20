import Link from 'next/link';
import {
  ICP_OPTIONS,
  COMPLETENESS_TIER_OPTIONS,
  SIGNAL_STRENGTH_OPTIONS,
  PRIMARY_DATA_CATEGORY_OPTIONS,
  API_TYPE_OPTIONS,
  AUTH_TYPE_OPTIONS,
  DATA_FORMAT_OPTIONS,
  DATA_FRESHNESS_OPTIONS,
  HEALTH_STATUS_OPTIONS,
  CRITICAL_FIELD_OPTIONS,
  SORT_FIELD_OPTIONS,
} from '@/lib/sourceFilterOptions';

type SearchParams = { [key: string]: string | string[] | undefined };

function checked(sp: SearchParams, key: string, value: string): boolean {
  const v = sp[key];
  if (v === undefined) return false;
  return Array.isArray(v) ? v.includes(value) : v === value;
}

function selectedValue(sp: SearchParams, key: string): string {
  const v = sp[key];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function CheckboxGroup({
  title,
  name,
  options,
  sp,
  labels,
}: {
  title: string;
  name: string;
  options: string[];
  sp: SearchParams;
  labels?: Record<string, string>;
}) {
  return (
    <details className="border-b border-border-base pb-3" open>
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">{title}</summary>
      <div className="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto pr-1 text-sm">
        {options.map((opt) => (
          <label key={opt} className="flex items-center gap-2 text-muted">
            <input
              type="checkbox"
              name={name}
              value={opt}
              defaultChecked={checked(sp, name, opt)}
              className="rounded border-border-base"
            />
            {labels?.[opt] ?? opt}
          </label>
        ))}
      </div>
    </details>
  );
}

export default function SourceFilterForm({ searchParams: sp }: { searchParams: SearchParams }) {
  const icpLabels = Object.fromEntries(ICP_OPTIONS.map((o) => [o.value, o.label]));

  return (
    <form
      method="get"
      action="/sources"
      className="h-fit space-y-4 rounded-lg border border-border-base bg-surface p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Filters</h2>
        <Link href="/control/sources" className="text-link text-xs font-medium hover:underline">
          Reset filters
        </Link>
      </div>

      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Search</label>
        <input
          type="text"
          name="q"
          defaultValue={selectedValue(sp, 'q')}
          placeholder="Source name or what it detects…"
          className="w-full rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
        />
      </div>

      <CheckboxGroup title="ICP" name="icp" options={ICP_OPTIONS.map((o) => o.value)} sp={sp} labels={icpLabels} />
      <CheckboxGroup title="Completeness Tier" name="tier" options={COMPLETENESS_TIER_OPTIONS} sp={sp} />

      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          Completeness Score
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            name="scoreMin"
            min={0}
            max={100}
            placeholder="Min"
            defaultValue={selectedValue(sp, 'scoreMin')}
            className="w-1/2 rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
          />
          <input
            type="number"
            name="scoreMax"
            min={0}
            max={100}
            placeholder="Max"
            defaultValue={selectedValue(sp, 'scoreMax')}
            className="w-1/2 rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      <CheckboxGroup title="Signal Strength" name="signal" options={SIGNAL_STRENGTH_OPTIONS} sp={sp} />
      <CheckboxGroup title="Data Category" name="category" options={PRIMARY_DATA_CATEGORY_OPTIONS} sp={sp} />
      <CheckboxGroup title="API Type" name="apiType" options={API_TYPE_OPTIONS} sp={sp} />
      <CheckboxGroup title="Auth Type" name="authType" options={AUTH_TYPE_OPTIONS} sp={sp} />
      <CheckboxGroup title="Data Format" name="format" options={DATA_FORMAT_OPTIONS} sp={sp} />
      <CheckboxGroup title="Data Freshness" name="freshness" options={DATA_FRESHNESS_OPTIONS} sp={sp} />

      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Coverage Country</label>
        <input
          type="text"
          name="country"
          defaultValue={selectedValue(sp, 'country')}
          placeholder="e.g. UK"
          className="w-full rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Coverage Region</label>
        <input
          type="text"
          name="region"
          defaultValue={selectedValue(sp, 'region')}
          placeholder="e.g. EU"
          className="w-full rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          Requires Enrichment
        </label>
        <select
          name="enrichment"
          defaultValue={selectedValue(sp, 'enrichment')}
          className="w-full rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
        >
          <option value="">Any</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          Enrichment Gap Score
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            name="gapMin"
            min={0}
            max={100}
            placeholder="Min"
            defaultValue={selectedValue(sp, 'gapMin')}
            className="w-1/2 rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
          />
          <input
            type="number"
            name="gapMax"
            min={0}
            max={100}
            placeholder="Max"
            defaultValue={selectedValue(sp, 'gapMax')}
            className="w-1/2 rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {(['active', 'configured', 'premium'] as const).map((name) => (
          <label key={name} className="flex flex-col items-start gap-1 text-xs text-muted">
            <span className="font-semibold uppercase tracking-wide text-muted">{name}</span>
            <select
              name={name}
              defaultValue={selectedValue(sp, name)}
              className="w-full rounded border border-border-base bg-surface px-1 py-1 text-xs"
            >
              <option value="">Any</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>
        ))}
      </div>

      <CheckboxGroup title="Health Status" name="health" options={HEALTH_STATUS_OPTIONS} sp={sp} />

      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          Must Include Field
        </label>
        <select
          name="fieldHas"
          defaultValue={selectedValue(sp, 'fieldHas')}
          className="w-full rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
        >
          <option value="">Any</option>
          {CRITICAL_FIELD_OPTIONS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
          Must NOT Include Field
        </label>
        <select
          name="fieldMissing"
          defaultValue={selectedValue(sp, 'fieldMissing')}
          className="w-full rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
        >
          <option value="">Any</option>
          {CRITICAL_FIELD_OPTIONS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Sort By</label>
        <div className="flex gap-2">
          <select
            name="sort"
            defaultValue={selectedValue(sp, 'sort') || 'priority_rank'}
            className="w-2/3 rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
          >
            {SORT_FIELD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            name="dir"
            defaultValue={selectedValue(sp, 'dir') || 'asc'}
            className="w-1/3 rounded border border-border-base bg-surface px-2 py-1.5 text-sm"
          >
            <option value="asc">Asc</option>
            <option value="desc">Desc</option>
          </select>
        </div>
      </div>

      <button
        type="submit"
        className="w-full rounded bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-surface-raised"
      >
        Apply Filters
      </button>
    </form>
  );
}
