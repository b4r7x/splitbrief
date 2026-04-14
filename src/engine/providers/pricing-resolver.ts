import { API_PROVIDER_IDS, CLI_TOOL_IDS, META_PROVIDER_IDS, type ProviderId } from '../../core/types/schemas/enums.js';
import { isProviderId, isProviderLocal, isProviderSubscription } from '../../core/providers.js';
import {
  NULL_CACHE,
  findKnownModel,
  getEffectiveModelId,
  lookupModelsDevModel,
  lookupRuntimeModel,
  type ModelCacheAccessor,
} from './model-resolution.js';

export interface ModelPricing {
  input: number | undefined;
  output: number | undefined;
  isFree: boolean | undefined;
}

export type PricingMode =
  | 'api-priced'
  | 'unpriced-cli'
  | 'unpriced-local'
  | 'unpriced-meta'
  | 'unpriced-unknown';

export interface ResolvedPricing {
  inputPer1M: number;
  outputPer1M: number;
  isLocal: boolean;
  isPriced: boolean;
  pricingMode: PricingMode;
  name: string;
  source: 'models-dev' | 'runtime' | 'bundled-fallback' | 'unpriced';
}

const PRICED_PROVIDER_IDS = new Set<ProviderId>(API_PROVIDER_IDS);
const UNPRICED_CLI_PROVIDER_IDS = new Set<string>(CLI_TOOL_IDS);
// Derived from META_PROVIDER_IDS so the two stay in sync automatically.
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
  const pricingMode: PricingMode =
    UNPRICED_CLI_PROVIDER_IDS.has(providerId) || isProviderSubscription(providerId) ? 'unpriced-cli'
    : META_UNPRICED_IDS.has(providerId) ? 'unpriced-meta'
    : 'unpriced-unknown';
  return {
    inputPer1M: 0,
    outputPer1M: 0,
    isLocal: false,
    isPriced: false,
    pricingMode,
    name: name ?? providerId,
    source: 'unpriced',
  };
}

export function isApiPricedProvider(providerId: string): providerId is ProviderId {
  return isProviderId(providerId) && PRICED_PROVIDER_IDS.has(providerId);
}

export function getPricingMode(providerId: ProviderId): PricingMode {
  if (isProviderLocal(providerId)) return 'unpriced-local';
  if (isApiPricedProvider(providerId)) return 'api-priced';
  if (UNPRICED_CLI_PROVIDER_IDS.has(providerId) || isProviderSubscription(providerId)) return 'unpriced-cli';
  return 'unpriced-meta';
}

export function lookupModelPricing(providerId: ProviderId, modelName: string, cache: ModelCacheAccessor = NULL_CACHE): ModelPricing | null {
  const match = lookupModelsDevModel(providerId, modelName, cache)
    ?? lookupRuntimeModel(providerId, modelName, cache);
  if (!match) return null;
  return {
    input: match.pricingInput,
    output: match.pricingOutput,
    isFree: match.isFree,
  };
}

export function formatPricing(input: number | undefined, output: number | undefined): string | null {
  if (input === undefined && output === undefined) return null;

  const formatNum = (n: number | undefined): string => {
    if (n === undefined) return '?';
    if (n === 0) return '$0';
    if (n < 0.01) return `$${n.toFixed(4)}`;
    if (n < 1) return `$${n.toFixed(2)}`;
    return `$${n}`;
  };

  return `${formatNum(input)}/${formatNum(output)}`;
}

function makePricedResult(modelId: string, input: number, output: number, source: ResolvedPricing['source']): ResolvedPricing {
  return {
    inputPer1M: input,
    outputPer1M: output,
    isLocal: false,
    isPriced: true,
    pricingMode: 'api-priced',
    name: modelId,
    source,
  };
}

export function resolvePricing(providerId: string, cache: ModelCacheAccessor = NULL_CACHE, modelId?: string): ResolvedPricing {
  if (!isProviderId(providerId)) return makeUnpriced(providerId, modelId);
  if (!isApiPricedProvider(providerId)) return makeUnpriced(providerId, modelId);

  const effectiveModelId = getEffectiveModelId(providerId, modelId);
  if (!effectiveModelId) return makeUnpriced(providerId, modelId);

  const modelsDev = lookupModelsDevModel(providerId, effectiveModelId, cache);
  if (modelsDev?.pricingInput !== undefined && modelsDev.pricingOutput !== undefined) {
    return makePricedResult(effectiveModelId, modelsDev.pricingInput, modelsDev.pricingOutput, 'models-dev');
  }

  const runtime = lookupRuntimeModel(providerId, effectiveModelId, cache);
  if (runtime?.pricingInput !== undefined && runtime.pricingOutput !== undefined) {
    return makePricedResult(effectiveModelId, runtime.pricingInput, runtime.pricingOutput, 'runtime');
  }

  const fallback = findKnownModel(providerId, effectiveModelId);
  if (fallback?.pricingInput !== undefined && fallback.pricingOutput !== undefined) {
    return makePricedResult(effectiveModelId, fallback.pricingInput, fallback.pricingOutput, 'bundled-fallback');
  }

  return makeUnpriced(providerId, effectiveModelId);
}
