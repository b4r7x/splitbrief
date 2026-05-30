import {
  API_PROVIDER_IDS,
  CLI_TOOL_IDS,
  META_PROVIDER_IDS,
  isProviderId,
  type ProviderId,
} from '../../core/schemas/enums.js';
import { isProviderLocal, isProviderSubscription } from '../../core/providers/catalog.js';
import {
  NULL_CACHE,
  findKnownModel,
  getEffectiveModelId,
  lookupModelsDevModel,
  lookupRuntimeModel,
  type ModelCacheAccessor,
} from './model/resolution.js';

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
  isLocal: boolean;
  isPriced: boolean;
  pricingMode: PricingMode;
  name: string;
  source: 'models-dev' | 'runtime' | 'bundled-fallback' | 'unpriced';
}

const PRICED_PROVIDER_IDS = new Set<ProviderId>(API_PROVIDER_IDS);
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
}): ResolvedPricing {
  const { modelId, input, output, source, cacheRead, cacheWrite } = opts;
  return {
    inputPer1M: input,
    outputPer1M: output,
    ...(cacheRead !== undefined && { cacheReadPer1M: cacheRead }),
    ...(cacheWrite !== undefined && { cacheWritePer1M: cacheWrite }),
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

  // models-dev and runtime catalogs do not currently expose cache pricing fields, so when they
  // produce a priced result we merge cache rates from the bundled fallback for the same
  // provider/model. This keeps cache-aware cost math consistent regardless of the data source.
  const bundled = findKnownModel(providerId, effectiveModelId);

  const modelsDev = lookupModelsDevModel(providerId, effectiveModelId, cache);
  if (modelsDev?.pricingInput !== undefined && modelsDev.pricingOutput !== undefined) {
    return makePricedResult({
      modelId: effectiveModelId,
      input: modelsDev.pricingInput,
      output: modelsDev.pricingOutput,
      source: 'models-dev',
      cacheRead: bundled?.pricingCacheRead,
      cacheWrite: bundled?.pricingCacheWrite,
    });
  }

  const runtime = lookupRuntimeModel(providerId, effectiveModelId, cache);
  if (runtime?.pricingInput !== undefined && runtime.pricingOutput !== undefined) {
    return makePricedResult({
      modelId: effectiveModelId,
      input: runtime.pricingInput,
      output: runtime.pricingOutput,
      source: 'runtime',
      cacheRead: bundled?.pricingCacheRead,
      cacheWrite: bundled?.pricingCacheWrite,
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
