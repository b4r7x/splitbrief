import { META_PROVIDER_IDS, type ProviderId } from '../../core/schemas/enums.js';
import { CLI_TOOL_IDS } from '../../core/runners/cli-tool-catalog.js';
import { REMOVED_CLI_TOOL_IDS, REMOVED_RUNNER_KINDS } from '../../core/schemas/runner-fields.js';
import { isApiProviderId } from '../../core/providers/api-provider-catalog.js';
import {
  isProviderLocal,
  isProviderSubscription,
  parseRunnerIdentityKey,
} from '../../core/providers/catalog.js';
import { isAutomaticModel } from '../../core/providers/automatic-model.js';
import {
  NULL_CACHE,
  findKnownModelByModelId,
  lookupCatalogModelByModelId,
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
  source: 'models-dev' | 'bundled-fallback' | 'unpriced';
  /** The runner or provider id these rates were resolved for. */
  provider: string;
  /**
   * The date the rate source itself publishes for these rates. Absent whenever
   * the source publishes none: the lookup time is not a rate date, and a row's
   * own last-changed date is not one either.
   */
  rateAsOf?: string;
}

// Persisted runs still name the identities this release removed, and the
// pricing candidate test below is a catch-all: without them a resumed
// `aider`/`agent-sdk` seat would be re-read as a metered custom endpoint and
// charged its model's rates.
const UNPRICED_CLI_PROVIDER_IDS = new Set<string>([...CLI_TOOL_IDS, ...REMOVED_CLI_TOOL_IDS]);
const META_UNPRICED_IDS = new Set<string>([...META_PROVIDER_IDS, ...REMOVED_RUNNER_KINDS]);

export const LOCAL_PRICING: ResolvedPricing = {
  inputPer1M: 0,
  outputPer1M: 0,
  isLocal: true,
  isPriced: false,
  pricingMode: 'unpriced-local',
  name: 'Local model',
  provider: 'local',
  source: 'unpriced',
};

function makeUnpriced(providerId: string, name?: string, mode?: PricingMode): ResolvedPricing {
  if (isProviderLocal(providerId)) {
    return { ...LOCAL_PRICING, provider: providerId, ...(name !== undefined && { name }) };
  }
  return {
    inputPer1M: 0,
    outputPer1M: 0,
    isLocal: false,
    isPriced: false,
    pricingMode: mode ?? pickUnpricedMode(providerId),
    name: name ?? providerId,
    provider: providerId,
    source: 'unpriced',
  };
}

function pickUnpricedMode(providerId: string): PricingMode {
  if (UNPRICED_CLI_PROVIDER_IDS.has(providerId) || isProviderSubscription(providerId))
    return 'unpriced-cli';
  if (META_UNPRICED_IDS.has(providerId)) return 'unpriced-meta';
  return 'unpriced-unknown';
}

/**
 * Whether a runner meters per token, so its rates are worth resolving. Rates
 * follow the model, not the provider preset: a custom endpoint the user
 * declared is a candidate exactly like a catalog remote provider would be.
 */
export function isApiPricedProvider(providerId: string): boolean {
  return (
    !isProviderLocal(providerId) &&
    !UNPRICED_CLI_PROVIDER_IDS.has(providerId) &&
    !isProviderSubscription(providerId) &&
    !META_UNPRICED_IDS.has(providerId)
  );
}

export function getPricingMode(providerId: ProviderId): PricingMode {
  if (isProviderLocal(providerId)) return 'unpriced-local';
  if (UNPRICED_CLI_PROVIDER_IDS.has(providerId) || isProviderSubscription(providerId))
    return 'unpriced-cli';
  return 'unpriced-meta';
}

function makePricedResult(opts: {
  providerId: string;
  modelId: string;
  input: number;
  output: number;
  source: ResolvedPricing['source'];
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  pricingTiers?: DetectedPricingTier[] | undefined;
  rateAsOf?: string | undefined;
}): ResolvedPricing {
  const { providerId, modelId, input, output, source, cacheRead, cacheWrite, pricingTiers } = opts;
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
    provider: providerId,
    source,
    ...(opts.rateAsOf !== undefined && { rateAsOf: opts.rateAsOf }),
  };
}

function pricingModelId(modelId?: string): string | undefined {
  const trimmed = modelId?.trim();
  if (trimmed === undefined || trimmed === '' || isAutomaticModel(trimmed)) return undefined;
  return trimmed;
}

/**
 * The rates one recorded runner's model is priced at. A kind-qualified identity
 * decides the lane before the name does: a `cli` runner is never metered even
 * when its name could be an API provider, and an `api` runner meters by model
 * even when its name is a CLI tool id the merged catalog would call unpriced.
 * A name with no kind keeps the name-only resolution for legacy records.
 */
export function resolvePricing(
  providerId: string,
  cache: ModelCacheAccessor = NULL_CACHE,
  modelId?: string,
): ResolvedPricing {
  const { kind, id } = parseRunnerIdentityKey(providerId);
  if (kind === 'cli') return makeUnpriced(id, modelId, 'unpriced-cli');
  if (kind === 'shell' || kind === 'agent') return makeUnpriced(id, modelId, 'unpriced-meta');
  if (kind === 'api' && !isApiProviderId(id)) {
    return resolveMeteredPricing({
      providerId: id,
      cache,
      modelId,
      unpricedMode: 'unpriced-unknown',
    });
  }
  if (!isApiPricedProvider(id)) return makeUnpriced(id, modelId);
  return resolveMeteredPricing({ providerId: id, cache, modelId });
}

/**
 * Rates by model id alone, for a metered runner: a catalogued provider whose
 * endpoint policy proved local was already answered unpriced above.
 */
function resolveMeteredPricing(input: {
  providerId: string;
  cache: ModelCacheAccessor;
  modelId: string | undefined;
  unpricedMode?: PricingMode | undefined;
}): ResolvedPricing {
  const { providerId, cache, modelId, unpricedMode } = input;
  const effectiveModelId = pricingModelId(modelId);
  if (!effectiveModelId) return makeUnpriced(providerId, modelId, unpricedMode);

  // Only a metered runner reaches here, so rates are looked up by model id alone.
  // Prefer cache rates from the catalog that priced input/output; when that catalog omits them
  // (or for the bundled path) fall back to the bundled fallback's verified cache rates so
  // cache-aware cost math stays consistent regardless of the data source.
  const bundled = findKnownModelByModelId(effectiveModelId);

  const modelsDev = lookupCatalogModelByModelId(effectiveModelId, cache);
  if (modelsDev?.pricingInput !== undefined && modelsDev.pricingOutput !== undefined) {
    return makePricedResult({
      providerId,
      modelId: effectiveModelId,
      input: modelsDev.pricingInput,
      output: modelsDev.pricingOutput,
      source: 'models-dev',
      // Only a dated pricing record dates these rates. The catalog row's own
      // last-changed date describes the row, not what the provider charged.
      rateAsOf: modelsDev.pricingProvenance?.asOf,
      cacheRead: modelsDev.pricingCacheRead ?? bundled?.pricingCacheRead,
      cacheWrite: modelsDev.pricingCacheWrite ?? bundled?.pricingCacheWrite,
      pricingTiers: modelsDev.pricingTiers,
    });
  }

  if (bundled?.pricingInput !== undefined && bundled.pricingOutput !== undefined) {
    return makePricedResult({
      providerId,
      modelId: effectiveModelId,
      input: bundled.pricingInput,
      output: bundled.pricingOutput,
      source: 'bundled-fallback',
      cacheRead: bundled.pricingCacheRead,
      cacheWrite: bundled.pricingCacheWrite,
    });
  }

  return makeUnpriced(providerId, effectiveModelId, unpricedMode);
}
