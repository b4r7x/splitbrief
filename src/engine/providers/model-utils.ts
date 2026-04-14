import type { DetectedModel } from '../../core/types/config.js';
import type { ProviderId } from '../../core/types/schemas/enums.js';
import { NULL_CACHE } from './model-resolution.js';
import { isApiPricedProvider, getPricingMode } from './pricing-resolver.js';

export type { ParsedModelId } from './model-parsing.js';
export { buildComparableKeys, idsMatch, parseModelId } from './model-parsing.js';

export type {
  ModelPricing,
  PricingMode,
  ResolvedPricing,
} from './pricing-resolver.js';
export {
  LOCAL_PRICING,
  isApiPricedProvider,
  getPricingMode,
  lookupModelPricing,
  formatPricing,
  resolvePricing,
} from './pricing-resolver.js';
export { NULL_CACHE };
export type { ModelCacheAccessor } from './model-resolution.js';

export interface ResolvedModelCatalogEntry extends DetectedModel {
  id: string;
  isDefault?: boolean;
  isDetected?: boolean;
  source: 'models-dev' | 'runtime' | 'bundled-fallback';
  pricingMode: import('./pricing-resolver.js').PricingMode;
}

export function mergeModelMetadata(
  providerId: ProviderId,
  base: ResolvedModelCatalogEntry | undefined,
  runtime: DetectedModel | undefined,
  modelsDev: DetectedModel | undefined,
): ResolvedModelCatalogEntry | undefined {
  const seed = base ?? (runtime
    ? {
        id: runtime.id,
        source: 'runtime' as const,
        pricingMode: getPricingMode(providerId),
      }
    : modelsDev
      ? {
          id: modelsDev.id,
          source: 'models-dev' as const,
          pricingMode: getPricingMode(providerId),
        }
      : undefined);

  if (!seed) return undefined;

  const contextLength = modelsDev?.contextLength ?? runtime?.contextLength ?? seed.contextLength;
  const pricingInput = modelsDev?.pricingInput ?? runtime?.pricingInput ?? seed.pricingInput;
  const pricingOutput = modelsDev?.pricingOutput ?? runtime?.pricingOutput ?? seed.pricingOutput;
  const isFree = modelsDev?.isFree ?? runtime?.isFree ?? seed.isFree;
  const isDetected = seed.isDetected ?? !!runtime;
  const releaseDate = modelsDev?.releaseDate ?? runtime?.releaseDate ?? seed.releaseDate;

  const merged: ResolvedModelCatalogEntry = {
    ...seed,
    source: modelsDev
      ? 'models-dev'
      : seed.source === 'models-dev'
        ? 'models-dev'
        : runtime
          ? 'runtime'
          : seed.source,
    ...(contextLength !== undefined && { contextLength }),
    ...(pricingInput !== undefined && { pricingInput }),
    ...(pricingOutput !== undefined && { pricingOutput }),
    ...(isFree !== undefined && { isFree }),
    ...(isDetected !== undefined && { isDetected }),
    ...(releaseDate !== undefined && { releaseDate }),
  };

  if (!isApiPricedProvider(providerId)) {
    delete merged.pricingInput;
    delete merged.pricingOutput;
    delete merged.isFree;
  }

  return merged;
}
