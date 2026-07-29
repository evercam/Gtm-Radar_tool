import 'server-only';

/**
 * GLEIF (Global Legal Entity Identifier Foundation) — keyless corporate
 * hierarchy. Given a company name, resolve its LEI, its ultimate parent, and
 * its direct subsidiaries. This is the account-structure signal that turns "a
 * company" into "a key account" (a group with many entities). Verified live
 * 2026-07-25. No key required.
 */

const BASE = 'https://api.gleif.org/api/v1';

export interface GleifEntity {
  lei: string;
  name: string;
  country: string | null;
}

export interface GleifResult {
  lei: string;
  legalName: string;
  country: string | null;
  jurisdiction: string | null;
  parent: GleifEntity | null; // ultimate parent
  subsidiaries: GleifEntity[]; // direct children (sample)
  subsidiaryTotal: number;
}

async function gj(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.api+json', 'User-Agent': 'EvercamSourceHub/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function entityOf(rec: any): GleifEntity | null {
  const a = rec?.attributes;
  const lei = a?.lei;
  if (!lei) return null;
  const name = a?.entity?.legalName?.name ?? (typeof a?.entity?.legalName === 'string' ? a.entity.legalName : '');
  return { lei, name: name || lei, country: a?.entity?.legalAddress?.country ?? null };
}

/** Normalize a name for matching (strip suffixes/punct). */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|plc|group|holdings|sa|spa|gmbh|ag|bv|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Guard against GLEIF's fuzzy name search returning an unrelated entity. */
function nameMatches(query: string, result: string): boolean {
  const q = norm(query);
  const r = norm(result);
  if (!q || !r) return false;
  if (q === r || r.startsWith(q) || q.startsWith(r)) return true;
  const qt = new Set(q.split(' ').filter(Boolean));
  const rt = r.split(' ').filter(Boolean);
  const overlap = rt.filter((t) => qt.has(t)).length;
  return overlap >= Math.min(2, qt.size); // require a couple of shared tokens
}

export async function gleifLookup(companyName: string | null | undefined): Promise<GleifResult | null> {
  const name = companyName?.trim();
  if (!name) return null;

  const search = await gj(`${BASE}/lei-records?filter[entity.legalName]=${encodeURIComponent(name)}&page[size]=1`);
  const rec = (search?.data as any[])?.[0];
  const lei = rec?.attributes?.lei;
  if (!lei) return null;

  const legalName = rec.attributes?.entity?.legalName?.name ?? name;
  if (!nameMatches(name, legalName)) return null; // avoid a wrong-entity match

  const [childrenResp, parentResp] = await Promise.all([
    gj(`${BASE}/lei-records/${lei}/direct-children?page[size]=15`),
    gj(`${BASE}/lei-records/${lei}/ultimate-parent`),
  ]);

  const childData = (childrenResp?.data as any[]) ?? [];
  const subsidiaries = childData.map(entityOf).filter((x): x is GleifEntity => x !== null);
  const subsidiaryTotal = ((childrenResp?.meta as any)?.pagination?.total as number) ?? subsidiaries.length;

  const parentData = parentResp?.data as any;
  const parent = parentData?.type === 'lei-records' ? entityOf(parentData) : null;

  return {
    lei,
    legalName,
    country: rec.attributes?.entity?.legalAddress?.country ?? null,
    jurisdiction: rec.attributes?.entity?.jurisdiction ?? null,
    parent,
    subsidiaries,
    subsidiaryTotal,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
