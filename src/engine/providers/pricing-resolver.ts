import { META_PROVIDER_IDS, isProviderId, type ProviderId } from '../../core/schemas/enums.js';
import { REMOTE_API_PROVIDER_IDS } from '../../core/providers/api-provider-catalog.js';
import { CLI_TOOL_IDS } from '../../core/runners/cli-tool-catalog.js';
import { isProviderLocal, isProviderSubscription } from '../../core/providers/catalog.js';
import {
  NULL_CACHE,
  findKnownModel,
  getEffectiveModelId,
  lookupModelsDevModel,
  lookupRuntimeModel,
  type ModelCacheAccessor,
} from './model/resolution.js';
import type { DetectedPricingTier } from '../../core/discovery/detection.js';

export type PricingMode =
  | 'api-priced'
  | 'unpriced-cli'
  | 'unpriced-local'
  | 'unpriced-meta'
  | 'unpriced-unknown';

export interface ResolvedPricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
  pricingTiers?: DetectedPricingTier[];
  isLocal: boolean;
  isPriced: boolean;
  pricingMode: PricingMode;
  name: string;
  source: 'models-dev' | 'runtime' | 'bundled-fallback' | 'unpriced';
}

const PRICED_PROVIDER_IDS = new Set<ProviderId>(REMOTE_API_PROVIDER_IDS);
const UNPRICED_CLI_PROVIDER_IDS = new Set<string>(CLI_TOOL_IDS);
const META_UNPRICED_IDS = new Set<string>(META_PROVIDER_IDS);

export const LOCAL_PRICING: ResolvedPricing = {
  inputPer1M: 0,
  outputPer1M: 0,
  isLocal: true,
  isPriced: false,
  pricingMode: 'unpriced-local',
  name: 'Local model',
  source: 'unpriced',
};

function makeUnpriced(providerId: string, name?: string): ResolvedPricing {
  if (isProviderLocal(providerId)) return name ? { ...LOCAL_PRICING, name } : LOCAL_PRICING;
  return {
    inputPer1M: 0,
    outputPer1M: 0,
    isLocal: false,
    isPriced: false,
    pricingMode: pickUnpricedMode(providerId),
    name: name ?? providerId,
    source: 'unpriced',
  };
}

function pickUnpricedMode(providerId: string): PricingMode {
  if (UNPRICED_CLI_PROVIDER_IDS.has(providerId) || isProviderSubscription(providerId))
    return 'unpriced-cli';
  if (META_UNPRICED_IDS.has(providerId)) return 'unpriced-meta';
  return 'unpriced-unknown';
}

export function isApiPricedProvider(providerId: string): providerId is ProviderId {
  return isProviderId(providerId) && PRICED_PROVIDER_IDS.has(providerId);
}

export function getPricingMode(providerId: ProviderId): PricingMode {
  if (isProviderLocal(providerId)) return 'unpriced-local';
  if (isApiPricedProvider(providerId)) return 'api-priced';
  if (UNPRICED_CLI_PROVIDER_IDS.has(providerId) || isProviderSubscription(providerId))
    return 'unpriced-cli';
  return 'unpriced-meta';
}

function makePricedResult(opts: {
  modelId: string;
  input: number;
  output: number;
  source: ResolvedPricing['source'];
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  pricingTiers?: DetectedPricingTier[] | undefined;
}): ResolvedPricing {
  const { modelId, input, output, source, cacheRead, cacheWrite, pricingTiers } = opts;
  return {
    inputPer1M: input,
    outputPer1M: output,
    ...(cacheRead !== undefined && { cacheReadPer1M: cacheRead }),
    ...(cacheWrite !== undefined && { cacheWritePer1M: cacheWrite }),
    ...(pricingTiers !== undefined && { pricingTiers }),
    isLocal: false,
    isPriced: true,
    pricingMode: 'api-priced',
    name: modelId,
    source,
  };
}

export function resolvePricing(
  providerId: string,
  cache: ModelCacheAccessor = NULL_CACHE,
  modelId?: string,
): ResolvedPricing {
  if (!isProviderId(providerId)) return makeUnpriced(providerId, modelId);
  if (!isApiPricedProvider(providerId)) return makeUnpriced(providerId, modelId);

  const effectiveModelId = getEffectiveModelId(providerId, modelId);
  if (!effectiveModelId) return makeUnpriced(providerId, modelId);

  // Prefer cache rates from the catalog that priced input/output; when that catalog omits them
  // (or for the bundled path) fall back to the bundled fallback's verified cache rates so
  // cache-aware cost math stays consistent regardless of the data source.
  const bundled = findKnownModel(providerId, effectiveModelId);

  const modelsDev = lookupModelsDevModel(providerId, effectiveModelId, cache);
  if (modelsDev?.pricingInput !== undefined && modelsDev.pricingOutput !== undefined) {
    return makePricedResult({
      modelId: effectiveModelId,
      input: modelsDev.pricingInput,
      output: modelsDev.pricingOutput,
      source: 'models-dev',
      cacheRead: modelsDev.pricingCacheRead ?? bundled?.pricingCacheRead,
      cacheWrite: modelsDev.pricingCacheWrite ?? bundled?.pricingCacheWrite,
      pricingTiers: modelsDev.pricingTiers,
    });
  }

  const runtime = lookupRuntimeModel(providerId, effectiveModelId, cache);
  if (runtime?.pricingInput !== undefined && runtime.pricingOutput !== undefined) {
    return makePricedResult({
      modelId: effectiveModelId,
      input: runtime.pricingInput,
      output: runtime.pricingOutput,
      source: 'runtime',
      cacheRead: runtime.pricingCacheRead ?? bundled?.pricingCacheRead,
      cacheWrite: runtime.pricingCacheWrite ?? bundled?.pricingCacheWrite,
      pricingTiers: runtime.pricingTiers,
    });
  }

  if (bundled?.pricingInput !== undefined && bundled.pricingOutput !== undefined) {
    return makePricedResult({
      modelId: effectiveModelId,
      input: bundled.pricingInput,
      output: bundled.pricingOutput,
      source: 'bundled-fallback',
      cacheRead: bundled.pricingCacheRead,
      cacheWrite: bundled.pricingCacheWrite,
    });
  }

  return makeUnpriced(providerId, effectiveModelId);
}
