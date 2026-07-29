export function formatCurrency(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString()}`;
  }
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(0)}%`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: '2-digit' });
}

export const CRITICAL_FIELD_LABELS: Record<string, string> = {
  project_name: 'Project Name',
  project_value: 'Project Value',
  project_location: 'Project Location',
  project_timeline: 'Project Timeline',
  building_type: 'Building Type',
  company_name: 'Company Name',
  company_contact: 'Company Contact',
  project_phase: 'Project Phase',
  square_footage: 'Square Footage',
  funding_source: 'Funding Source',
  company_website: 'Company Website',
  company_phone: 'Company Phone',
};

export const ALL_CRITICAL_FIELD_KEYS = Object.keys(CRITICAL_FIELD_LABELS);
