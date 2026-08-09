import { barbourAbiAdapter } from './barbour-abi';
import { gleniganAdapter } from './glenigan';
import { constructConnectAdapter } from './construct-connect';
import { samGovAdapter } from './sam-gov';
import { secEdgarAdapter } from './sec-edgar';
import { findATenderAdapter, austenderAdapter, contractsFinderAdapter } from './ocds';
import { tedAdapter } from './ted';
import { worldBankAdapter } from './world-bank';
import { usaSpendingAdapter } from './usaspending';
import { planningIeAdapter } from './planning-ie';
import { nycPermitsAdapter, chicagoPermitsAdapter } from './socrata-permits';
import {
  dataCenterDynamicsAdapter,
  dataCenterKnowledgeAdapter,
  semiconductorDigestAdapter,
  electriveAdapter,
  powerTechnologyAdapter,
  nuclearEngineeringAdapter,
  miningComAdapter,
  constructionDiveAdapter,
} from './rss-news';
import { gemAdapter } from './gem';
import { newsSearchAdapter } from './news-search';
import type { SourceAdapter } from './types';

/**
 * Sources with real, working ingestion adapters. Every other source in
 * `source_registry` is catalog-only (seeded metadata, no live fetching) —
 * this is deliberate, not a gap.
 */
export const LIVE_ADAPTERS: Record<string, SourceAdapter> = {
  'barbour-abi': barbourAbiAdapter,
  glenigan: gleniganAdapter,
  'construct-connect': constructConnectAdapter,
  'sam-gov': samGovAdapter,
  'sec-edgar': secEdgarAdapter,
  'find-a-tender': findATenderAdapter,
  austender: austenderAdapter,
  'contracts-finder': contractsFinderAdapter,
  ted: tedAdapter,
  'world-bank': worldBankAdapter,
  usaspending: usaSpendingAdapter,
  'planning-ie': planningIeAdapter,
  'nyc-permits': nycPermitsAdapter,
  'chicago-permits': chicagoPermitsAdapter,
  'data-center-dynamics': dataCenterDynamicsAdapter,
  'data-center-knowledge': dataCenterKnowledgeAdapter,
  'semiconductor-digest': semiconductorDigestAdapter,
  electrive: electriveAdapter,
  'power-technology': powerTechnologyAdapter,
  'nuclear-engineering': nuclearEngineeringAdapter,
  'mining-com': miningComAdapter,
  'construction-dive': constructionDiveAdapter,
  gem: gemAdapter,
  'news-search': newsSearchAdapter,
};

export function getLiveAdapter(source: string): SourceAdapter | null {
  return LIVE_ADAPTERS[source] ?? null;
}

export const LIVE_SOURCE_SLUGS = Object.keys(LIVE_ADAPTERS);
