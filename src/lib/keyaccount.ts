/**
 * Key-account rubric. A key account is worth a strategic/ABM motion because it
 * represents MANY camera opportunities over time, not one project. Score 0..100
 * from weighted signals; `key_account` is true above the threshold OR on any
 * hard trigger. Everything here is tunable in one place.
 */

export interface KeyAccountInputs {
  /** Other active projects Claude found for this entity. */
  relatedProjectsCount: number;
  /** Estimated total portfolio value (USD) from Claude. */
  portfolioValue: number | null;
  /** owner / developer / general_contractor / operator / architect. */
  role: string | null;
  /** The lead's ICP code. */
  icpCode: string | null;
  /** The lead's vertical (data_center, semiconductor, solar, …). */
  vertical: string | null;
  /** The lead's own estimated value (USD) — anchor deal size. */
  projectValue: number | null;
  /** Non-empty when Claude found a funding/expansion/pipeline signal. */
  expansionSignal: string | null;
  /** Distinct business units this account spans (from the DB rollup, if known). */
  buSpread?: number;
  /** GLEIF-verified direct subsidiary count — corporate footprint. */
  subsidiaryCount?: number;
}

export interface KeyAccountVerdict {
  score: number;
  isKey: boolean;
  reasons: string[];
}

// ---- tunables ---------------------------------------------------------------
export const KEY_ACCOUNT_CONFIG = {
  threshold: 60, // score at/above which an account is "key"
  weights: {
    relatedProjects: 25, // portfolio breadth (5 projects saturates)
    portfolioValue: 20, // $1B saturates
    ownerRole: 15, // recurring buyer
    strategicIcp: 10,
    sectorFit: 10,
    projectSize: 10, // $250M saturates
    expansion: 5,
    buSpread: 5, // 3 BUs saturates
  },
  hardTriggers: {
    relatedProjects: 3, // >= this many related projects => key
    portfolioValue: 500_000_000, // >= $500M portfolio => key
  },
  strategicIcps: ['mission_critical_owner', 'critical_infra_owner', 'tier1_gc'],
  ownerRoles: ['owner', 'developer', 'operator'],
  coreVerticals: ['data_center', 'semiconductor', 'battery', 'nuclear', 'solar', 'wind', 'hydro', 'oil_gas'],
};

/**
 * Slug for an owner name as sources publish it — the `N:` half of
 * `owner_group_key`.
 *
 * Sources annotate ownership with shares and list co-owners in one field
 * (`Alabama Power Co [50%]; Georgia Power Co [50%]`). The first owner is the
 * majority holder throughout GEM, so it wins; the percentages are noise.
 *
 * Exported and shared on purpose: ingest, `resolve-owner-groups` and
 * `verify-owner-groups` must agree on this exactly. Three private copies is how
 * the resolver ends up unable to see rows it should have upgraded, and the
 * verifier ends up reporting a clean run anyway.
 */
export function ownerNameSlug(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return accountKey(raw.split(';')[0].replace(/\[[^\]]*\]/g, ''));
}

/** Normalize a company name into a stable account_key (google-llc, aes-corp…). */
export function accountKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const k = name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|plc|group|holdings|sa|spa|gmbh|ag|bv|pty|the)\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return k.length ? k : null;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function scoreKeyAccount(i: KeyAccountInputs): KeyAccountVerdict {
  const w = KEY_ACCOUNT_CONFIG.weights;
  const reasons: string[] = [];
  let score = 0;

  const rel = i.relatedProjectsCount || 0;
  score += w.relatedProjects * clamp01(rel / 5);
  if (rel >= 2) reasons.push(`${rel} related projects in portfolio`);

  const pv = i.portfolioValue ?? 0;
  score += w.portfolioValue * clamp01(pv / 1_000_000_000);
  if (pv > 0) reasons.push(`~$${Math.round(pv / 1_000_000)}M portfolio value`);

  const isOwner = i.role ? KEY_ACCOUNT_CONFIG.ownerRoles.includes(i.role.toLowerCase()) : false;
  if (isOwner) {
    score += w.ownerRole;
    reasons.push(`${i.role} — recurring buyer`);
  }

  if (i.icpCode && KEY_ACCOUNT_CONFIG.strategicIcps.includes(i.icpCode)) {
    score += w.strategicIcp;
    reasons.push('strategic ICP');
  }

  if (i.vertical && KEY_ACCOUNT_CONFIG.coreVerticals.includes(i.vertical)) {
    score += w.sectorFit;
    reasons.push(`core vertical (${i.vertical})`);
  }

  const projV = i.projectValue ?? 0;
  score += w.projectSize * clamp01(projV / 250_000_000);

  if (i.expansionSignal && i.expansionSignal.trim()) {
    score += w.expansion;
    reasons.push('active expansion signal');
  }

  if (i.buSpread && i.buSpread > 1) {
    score += w.buSpread * clamp01((i.buSpread - 1) / 2);
    reasons.push(`${i.buSpread} regions`);
  }

  // GLEIF corporate footprint — a large legal-entity group is a key-account signal.
  const subs = i.subsidiaryCount ?? 0;
  if (subs >= 3) {
    score += 8 * clamp01(subs / 20);
    reasons.push(`${subs}+ GLEIF subsidiaries`);
  }

  score = Math.round(clamp01(score / 100) * 100);

  const hard =
    rel >= KEY_ACCOUNT_CONFIG.hardTriggers.relatedProjects ||
    pv >= KEY_ACCOUNT_CONFIG.hardTriggers.portfolioValue ||
    (isOwner &&
      Boolean(i.expansionSignal?.trim()) &&
      Boolean(i.icpCode && KEY_ACCOUNT_CONFIG.strategicIcps.includes(i.icpCode)));

  const isKey = hard || score >= KEY_ACCOUNT_CONFIG.threshold;
  if (hard && !reasons.includes('meets hard trigger')) reasons.unshift('meets key-account trigger');

  return { score, isKey, reasons };
}
